import { connect, LocalArchiveStore } from '@fs-billing/db';
import { pino } from 'pino';
import { startReconciliation } from './reconcile.js';
import { createWorker } from './app.js';
import { startRawArchive } from './archive.js';
import { mailSettingsOf, workerEnvironmentSchema } from './config.js';
import { CHARGE_QUEUE, chargeQueue, createBoss } from './queue.js';
import { chargeCdr } from './charge.js';
import { startNotifyJobs } from './mail.js';
import { startPartitionMaintenance } from './maintenance.js';
import { requestStatementCatchUp, startStatementJobs } from './statements.js';

const config = workerEnvironmentSchema.parse(process.env);
const logger = pino();
const connection = connect(config.APP_DATABASE_URL, {
  poolName: 'worker.business',
  logger,
  max: config.WORKER_DB_POOL_MAX,
  connectionTimeoutMillis: config.WORKER_DB_CONNECTION_TIMEOUT_MS,
});
// pg-boss 冷缓存读取不能等待入库事务占满的业务连接池。
const queueConnection = connect(config.APP_DATABASE_URL, {
  poolName: 'worker.queue',
  logger,
  max: config.WORKER_QUEUE_POOL_MAX,
  connectionTimeoutMillis: config.WORKER_DB_CONNECTION_TIMEOUT_MS,
});
const boss = createBoss(queueConnection.db);
const app = createWorker({
  loggerInstance: logger,
  db: connection.db,
  queue: chargeQueue(boss),
  security: {
    secret: config.WORKER_SHARED_KEY,
    allowedIps: config.WORKER_ALLOWED_IPS,
  },
});
boss.on('error', (error) => app.log.error({ err: error }, '队列错误'));
app.addHook('onClose', async () => {
  await boss.stop();
  await queueConnection.pool.end();
  await connection.pool.end();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      app.log.error({ err: error }, '关闭 Worker 失败');
      process.exitCode = 1;
    });
  });
}
try {
  await boss.start();
  await startPartitionMaintenance(boss, connection.db, app.log);
  await boss.work(CHARGE_QUEUE, async (jobs) => {
    for (const job of jobs) {
      try {
        await chargeCdr(connection.db, job.data);
      } catch (error) {
        app.log.error({ err: error, jobId: job.id }, '话单扣费失败');
        throw error;
      }
    }
  });
  await startReconciliation(
    boss,
    connection.db,
    {
      minAgeMinutes: config.WORKER_RECONCILE_MIN_AGE_MINUTES,
      alertAttempts: config.WORKER_RECONCILE_ALERT_ATTEMPTS,
      lookbackDays: config.WORKER_RECONCILE_LOOKBACK_DAYS,
    },
    app.log,
  );
  await startStatementJobs(
    boss,
    connection.db,
    {
      concurrency: config.WORKER_STATEMENT_CONCURRENCY,
    },
    app.log,
  );
  await requestStatementCatchUp(boss);
  if (config.RAW_CDR_ARCHIVE_DIR)
    await startRawArchive(
      boss,
      connection.db,
      new LocalArchiveStore(config.RAW_CDR_ARCHIVE_DIR),
      {
        afterMonths: config.RAW_CDR_ARCHIVE_AFTER_MONTHS,
        graceDays: config.RAW_CDR_ARCHIVE_GRACE_DAYS,
      },
      app.log,
    );
  else
    app.log.warn(
      '未设置 RAW_CDR_ARCHIVE_DIR：原始话单归档未启用，raw_cdrs 的老分区不会被归档或丢弃',
    );
  const mail = mailSettingsOf(config);
  if (!mail)
    app.log.warn(
      '未设置 SMTP_HOST：邮件发送未启用，发件箱照常入队但不会发出（余额提醒、故障告警邮件）',
    );
  await startNotifyJobs(boss, connection.db, {
    mail,
    quietMinutes: config.ALERT_QUIET_MINUTES,
    logger: app.log,
  });
  app.log.info(
    `Worker listening at ${await app.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT })}`,
  );
} catch (error) {
  app.log.error({ err: error }, 'Worker 启动失败');
  await app.close();
  process.exitCode = 1;
}
