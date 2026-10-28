import pg from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';
import { seedDatabase } from '../../../packages/db/src/seed.js';
import { scratchDatabase } from '../../../packages/db/test/scratch.js';
import { createApi } from '../src/app.js';
import { createBetterAuth } from '../src/auth/better-auth.js';
import { createAuthGateway } from '../src/auth/gateway.js';
import { login, origin, type FixtureUser } from './support.js';

/**
 * 在单独的、播过种子的库里起一个 API：测试要提交会改变种子数字的操作
 * （例如把 ABC01 的 326 条分配给 ABC001，余额 −35.20 → −93.55），不能写进共享测试库。
 * 种子管理员（王敏）登录用的凭据在这里补上；库在 beforeAll 里建好、afterAll 里删掉。
 */
export function seededApi() {
  const database = scratchDatabase({ seed: true });
  const state: {
    api?: ReturnType<typeof createApi>;
    authPool?: pg.Pool;
    cookie?: string;
  } = {};
  const password = 'Seeded-admin-password-47';

  beforeAll(async () => {
    const appUrl = new URL(database.app.pool.options.connectionString ?? '');
    const authUrl = new URL(inject('authUrl'));
    authUrl.pathname = appUrl.pathname;
    state.authPool = new pg.Pool({ connectionString: authUrl.toString() });
    const settings = {
      secret: 'test-only-secret-with-at-least-32-characters',
      baseURL: origin,
      secureCookies: true,
      trustedOrigins: [origin],
    };
    const hash = await (
      await createBetterAuth({ pool: state.authPool, ...settings }).$context
    ).password.hash(password);
    // 已有凭据的账号保持不变，种子管理员原本没有登录密码。
    await seedDatabase(database.owner.db, { passwordHash: hash });
    const auth = createAuthGateway({
      pool: state.authPool,
      ...settings,
      logger: { info: () => undefined, error: () => undefined },
    });
    state.api = createApi({
      businessDb: database.app.db,
      auth,
      trustedOrigins: [origin],
      rateLimit: { max: 1000, timeWindow: 60_000 },
    });
    const admin = (
      await database.owner.pool.query<{
        id: string;
        auth_user_id: string;
        email: string;
      }>(
        `SELECT a.id, a.auth_user_id, u.email FROM public.admins a
         JOIN auth."user" u ON u.id = a.auth_user_id WHERE u.email = 'wangmin@example.com'`,
      )
    ).rows[0]!;
    const user: FixtureUser = {
      userId: admin.auth_user_id,
      profileId: admin.id,
      email: admin.email,
      tenantId: null,
    };
    state.cookie = (await login(state.api, user, password)).cookie;
  }, 60_000);

  afterAll(async () => {
    await state.api?.close();
    await state.authPool?.end();
  });

  return {
    owner: () => database.owner,
    app: () => database.app,
    api: () => state.api!,
    cookie: () => state.cookie!,
  };
}
