import Fastify from 'fastify';
import { healthResponseSchema } from '@fs-billing/shared';

export function createWorker() {
  const app = Fastify();
  app.get('/health', () =>
    healthResponseSchema.parse({ status: 'ok', service: 'worker' }),
  );
  return app;
}
