import { z } from 'zod';

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.enum(['api', 'worker']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const serverEnvironmentSchema = z.object({
  host: z.string().min(1),
  port: z.coerce.number().int().min(1).max(65535),
});
