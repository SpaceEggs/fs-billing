import { createWorker } from './app.js';
import { serverEnvironmentSchema } from '@fs-billing/shared';

const config = serverEnvironmentSchema.parse({
  host: process.env['WORKER_HOST'] ?? '127.0.0.1',
  port: process.env['WORKER_PORT'] ?? '3001',
});
const app = createWorker();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}
try {
  console.info(`Worker listening at ${await app.listen(config)}`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
