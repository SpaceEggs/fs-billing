import { isIP } from 'node:net';
import { isAbsolute } from 'node:path';
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
  WORKER_RECONCILE_LOOKBACK_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(365)
    .default(30),
  WORKER_STATEMENT_CONCURRENCY: z.coerce
    .number()
    .int()
    .min(1)
    .max(10)
    .default(2),
  // 原始 JSON 归档（阶段 8）：本地目录，必须是绝对路径；不设置则不启用归档（启动时告警）。
  RAW_CDR_ARCHIVE_DIR: z.preprocess(
    (value) => (value === '' ? undefined : value),
    z
      .string()
      .refine((value) => isAbsolute(value), '归档目录必须是绝对路径')
      .optional(),
  ),
  // 月份 M 的原文在 M 月末之后再过这么多个月才归档。
  RAW_CDR_ARCHIVE_AFTER_MONTHS: z.coerce
    .number()
    .int()
    .min(1)
    .max(120)
    .default(6),
  // 分离之后保留 raw_cdrs_YYYY_MM_archived 这么多天再丢弃。
  RAW_CDR_ARCHIVE_GRACE_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(365)
    .default(7),
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
