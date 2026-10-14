import pg from 'pg';
import { z } from 'zod';
import { connect, databaseEnvironmentSchema } from '@fs-billing/db';
import { newPasswordSchema } from '@fs-billing/shared';
import { seedDatabase } from '../../../packages/db/src/seed.js';
import { createBetterAuth } from '../src/auth/better-auth.js';

const env = databaseEnvironmentSchema
  .extend({
    AUTH_DATABASE_URL:
      databaseEnvironmentSchema.shape.AUTH_DATABASE_URL.unwrap(),
    SEED_AUTH_PASSWORD: newPasswordSchema,
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    NODE_ENV: z.enum(['development', 'test']).default('development'),
  })
  .parse(process.env);
if (
  ['fs_billing_app', 'fs_billing_auth', 'fs_billing_identity'].includes(
    decodeURIComponent(new URL(env.DATABASE_URL).username),
  )
) {
  throw new Error('开发凭据初始化必须使用 owner DATABASE_URL');
}
const owner = connect(env.DATABASE_URL);
const pool = new pg.Pool({ connectionString: env.AUTH_DATABASE_URL });
try {
  const auth = createBetterAuth({
    pool,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    secureCookies: false,
    trustedOrigins: [new URL(env.BETTER_AUTH_URL).origin],
  });
  const passwordHash = await (
    await auth.$context
  ).password.hash(env.SEED_AUTH_PASSWORD);
  await seedDatabase(owner.db, { passwordHash });
  process.stdout.write('开发种子凭据已初始化，已有凭据保持不变。\n');
} finally {
  await Promise.all([owner.pool.end(), pool.end()]);
}
