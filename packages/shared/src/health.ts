import { z } from 'zod';

export const healthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  service: z.enum(['api', 'worker']),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;
