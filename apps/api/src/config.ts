import { z } from 'zod';
import { databaseEnvironmentSchema } from '@fs-billing/db';
import {
  DEFAULT_TENANT_OVERDRAFT_LIMIT,
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS,
  DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS,
  DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS,
  DEFAULT_ADMIN_TEMPORARY_PASSWORD_TTL_MS,
} from '@fs-billing/shared';
import type { ApiDependencies } from './app.js';

const authUrl = z
  .url()
  .refine(
    (value) =>
      /^postgres(?:ql)?:/.test(value) &&
      decodeURIComponent(new URL(value).username) === 'fs_billing_auth',
    { message: '认证连接必须使用 fs_billing_auth' },
  );
export const apiEnvironmentSchema = databaseEnvironmentSchema
  .pick({ APP_DATABASE_URL: true })
  .extend({
    AUTH_DATABASE_URL: authUrl,
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    BETTER_AUTH_TRUSTED_ORIGINS: z
      .string()
      .transform((value) => value.split(',').map((origin) => origin.trim()))
      .pipe(
        z
          .array(
            z.url().refine((value) => new URL(value).origin === value, {
              message: '可信 Origin 不能包含路径或末尾斜杠',
            }),
          )
          .min(1),
      )
      .optional(),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX: z
      .string()
      .regex(/^[0-9]+$/)
      .transform(Number)
      .pipe(z.number().int().positive())
      .optional(),
    FSB_ALLOW_TEST_OVERRIDES: z.string().optional(),
    ADMIN_AMOUNT_MAX_INTEGER_DIGITS: z.coerce
      .number()
      .int()
      .min(1)
      .max(128)
      .default(DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS),
    ADMIN_RATE_SCHEDULE_HORIZON_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS),
    ADMIN_RATE_PREVIEW_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS),
    ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS: z.coerce
      .number()
      .int()
      .nonnegative()
      .default(DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS),
    ADMIN_TEMPORARY_PASSWORD_TTL_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(DEFAULT_ADMIN_TEMPORARY_PASSWORD_TTL_MS),
    // 邮件发送是否启用的开关（阶段 9）：只给设置页显示「邮件发送未配置」，不含任何凭据；
    // 与 Worker 的 SMTP_HOST 在同一个环境文件里一起设置（API 自己没有 SMTP 凭据，判断不了）。
    MAIL_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
  })
  .superRefine((value, ctx) => {
    if (
      value.AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX !== undefined &&
      (value.NODE_ENV !== 'test' || value.FSB_ALLOW_TEST_OVERRIDES !== '1')
    )
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX'],
        message:
          'AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX requires explicit NODE_ENV=test and FSB_ALLOW_TEST_OVERRIDES=1',
      });
    const minimumAmountDigits = Math.max(
      ...Object.values(DEFAULT_TENANT_OVERDRAFT_LIMIT).map(
        (amount) => amount.replace(/\..*$/, '').length,
      ),
    );
    if (value.ADMIN_AMOUNT_MAX_INTEGER_DIGITS < minimumAmountDigits)
      ctx.addIssue({
        code: 'custom',
        path: ['ADMIN_AMOUNT_MAX_INTEGER_DIGITS'],
        message: `金额整数位上限不能小于租户默认透支额度的整数位数 ${minimumAmountDigits}`,
      });
    if (
      value.NODE_ENV === 'production' &&
      new URL(value.BETTER_AUTH_URL).protocol !== 'https:'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_URL'],
        message: '生产认证 URL 必须使用 HTTPS',
      });
  });

export function apiRateLimitOptions(
  config: z.infer<typeof apiEnvironmentSchema>,
): Pick<ApiDependencies, 'rateLimit'> {
  return config.AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX !== undefined
    ? {
        rateLimit: {
          max: config.AUTH_RATE_LIMIT_TEST_OVERRIDE_MAX,
          timeWindow: 60_000,
        },
      }
    : {};
}
