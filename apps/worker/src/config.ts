import { isIP } from 'node:net';
import { z } from 'zod';
import { databaseEnvironmentSchema } from '@fs-billing/db';

function privateIpv4(value: string) {
  if (isIP(value) !== 4) return false;
  const [a, b] = value.split('.').map(Number);
  return (
    a === 127 ||
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b !== undefined && b >= 16 && b <= 31)
  );
}
export const workerEnvironmentSchema = z.object({
  APP_DATABASE_URL: databaseEnvironmentSchema.shape.APP_DATABASE_URL,
  WORKER_DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_QUEUE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(2),
  WORKER_DB_CONNECTION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(60000)
    .default(5000),
  WORKER_RECONCILE_MIN_AGE_MINUTES: z.coerce
    .number()
    .int()
    .min(1)
    .max(10080)
    .default(5),
  WORKER_RECONCILE_ALERT_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1)
    .max(1000)
    .default(3),
  WORKER_HOST: z
    .string()
    .refine(privateIpv4, '只能监听内网或回环 IPv4 地址')
    .default('127.0.0.1'),
  WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WORKER_SHARED_KEY: z.string().min(16),
  WORKER_ALLOWED_IPS: z
    .string()
    .transform((value) => value.split(',').map((ip) => ip.trim()))
    .pipe(
      z
        .array(
          z.string().refine((value) => isIP(value) !== 0, 'IP 白名单格式错误'),
        )
        .min(1),
    ),
});
