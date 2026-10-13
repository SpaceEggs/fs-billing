import { connect, ensureCdrPartitions } from '@fs-billing/db';
import { createWorker } from './app.js';
import { workerEnvironmentSchema } from './config.js';
import { CHARGE_QUEUE, chargeQueue, createBoss } from './queue.js';
import { chargeCdr } from './charge.js';
import { recordAlert } from './ingest.js';

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
  try {
    await ensureCdrPartitions(connection.db);
  } catch (error) {
    app.log.error({ err: error }, '启动建分区失败');
    await recordAlert(connection.db, 'partition_failed', '启动建分区失败');
    throw error;
  }
  await boss.start();
  await boss.work(CHARGE_QUEUE, async (jobs) => {
    for (const job of jobs) await chargeCdr(connection.db, job.data);
  });
  app.log.info(
    `Worker listening at ${await app.listen({ host: config.WORKER_HOST, port: config.WORKER_PORT })}`,
  );
} catch (error) {
  app.log.error({ err: error }, 'Worker 启动失败');
  await app.close();
  process.exitCode = 1;
}
