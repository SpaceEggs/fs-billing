import { connect } from '@fs-billing/db';
import { createWorker } from './app.js';
import { workerEnvironmentSchema } from './config.js';
import { CHARGE_QUEUE, chargeQueue, createBoss } from './queue.js';
import { chargeCdr } from './charge.js';
import { recordAlert } from './ingest.js';
import { startPartitionMaintenance } from './maintenance.js';

const config = workerEnvironmentSchema.parse(process.env);
const connection = connect(config.APP_DATABASE_URL);
const boss = createBoss(connection.db);
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
boss.on('error', (error) => app.log.error({ err: error }, '队列错误'));
app.addHook('onClose', async () => {
  await boss.stop();
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
        await recordAlert(
          connection.db,
          'cdr_failed',
          `任务 ${job.id}: 扣费失败`,
        );
        throw error;
      }
    }
  });
  app.log.info(
    `Worker listening at ${await app.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT })}`,
  );
} catch (error) {
  app.log.error({ err: error }, 'Worker 启动失败');
  await app.close();
  process.exitCode = 1;
}
