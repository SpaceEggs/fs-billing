import { connect, LocalArchiveStore } from '@fs-billing/db';
import { startReconciliation } from './reconcile.js';
import { createWorker } from './app.js';
import { startRawArchive } from './archive.js';
import { mailSettingsOf, workerEnvironmentSchema } from './config.js';
import { CHARGE_QUEUE, chargeQueue, createBoss } from './queue.js';
import { chargeCdr } from './charge.js';
import { startNotifyJobs } from './notify.js';
import { createWorkerLogger } from './redact.js';
import { startPartitionMaintenance } from './maintenance.js';
import { requestStatementCatchUp, startStatementJobs } from './statements.js';

const config = workerEnvironmentSchema.parse(process.env);
// 日志脱敏见 redact.ts：共享密钥、授权头、数据库错误的 detail。
const logger = createWorkerLogger();
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
// 收到停止信号后，邮件分发在两封之间停下并释放没发的，而不是发完一封再让完成写入撞上关闭中的连接池。
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdown.abort();
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
    signal: shutdown.signal,
  });
  app.log.info(
    `Worker listening at ${await app.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT })}`,
  );
} catch (error) {
  app.log.error({ err: error }, 'Worker 启动失败');
  await app.close();
  process.exitCode = 1;
}
