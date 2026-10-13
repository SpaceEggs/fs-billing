import { connect } from '@fs-billing/db';
import { startReconciliation } from './reconcile.js';
import { createWorker } from './app.js';
import { workerEnvironmentSchema } from './config.js';
import { CHARGE_QUEUE, chargeQueue, createBoss } from './queue.js';
import { chargeCdr } from './charge.js';
import { startPartitionMaintenance } from './maintenance.js';

const config = workerEnvironmentSchema.parse(process.env);
const connection = connect(config.APP_DATABASE_URL, {
  max: config.WORKER_DB_POOL_MAX,
  connectionTimeoutMillis: config.WORKER_DB_CONNECTION_TIMEOUT_MS,
});
// pg-boss 冷缓存读取不能等待入库事务占满的业务连接池。
const queueConnection = connect(config.APP_DATABASE_URL, {
  max: config.WORKER_QUEUE_POOL_MAX,
  connectionTimeoutMillis: config.WORKER_DB_CONNECTION_TIMEOUT_MS,
});
const boss = createBoss(queueConnection.db);
const app = createWorker({
  logger: true,
  db: connection.db,
  queue: chargeQueue(boss),
  security: {
    secret: config.WORKER_SHARED_KEY,
    allowedIps: config.WORKER_ALLOWED_IPS,
  },
});
connection.pool.on('error', (error) =>
  app.log.error({ err: error }, '数据库空闲连接错误'),
);
queueConnection.pool.on('error', (error) =>
  app.log.error({ err: error }, '队列数据库空闲连接错误'),
);
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
  app.log.info(
    `Worker listening at ${await app.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT })}`,
  );
} catch (error) {
  app.log.error({ err: error }, 'Worker 启动失败');
  await app.close();
  process.exitCode = 1;
}
