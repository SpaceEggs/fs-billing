import { z } from 'zod';
import { databaseEnvironmentSchema } from '@fs-billing/db';

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
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
  })
  .superRefine((value, ctx) => {
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
