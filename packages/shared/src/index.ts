import { z } from 'zod';

export const serverEnvironmentSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
});

export * from './worker.js';
export * from './health.js';
export * from './api/index.js';
export * from './hangup-cause.js';
export * from './mail/index.js';
