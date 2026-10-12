import Fastify from 'fastify';
import { healthResponseSchema } from '@fs-billing/shared';

export function createApi() {
  const app = Fastify();
  app.get('/api/health', () =>
    healthResponseSchema.parse({ status: 'ok', service: 'api' }),
  );
  return app;
}
