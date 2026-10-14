import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, inject } from 'vitest';
import type {} from '../../../packages/db/test/global-setup.js';
import { appendLedgerEntries, connect, withAdmin } from '@fs-billing/db';
import { money } from '@fs-billing/rating';
import { sessionResponseSchema } from '@fs-billing/shared';
import { createApi } from '../src/app.js';
import { createBetterAuth } from '../src/auth/better-auth.js';
import { createAuthGateway } from '../src/auth/gateway.js';
import type { AuthHooks } from '../src/auth/types.js';

export const origin = 'http://localhost:3000';
export const password = 'Fixture-password-47';

export function apiConnections() {
  const owner = connect(inject('ownerUrl'));
  const app = connect(inject('appUrl'));
  const authPool = new pg.Pool({ connectionString: inject('authUrl') });
  const betterAuth = createBetterAuth({
    pool: authPool,
    secret: 'test-only-secret-with-at-least-32-characters',
    baseURL: origin,
    secureCookies: true,
    trustedOrigins: [origin],
  });
  afterAll(async () => {
    await Promise.all([owner.pool.end(), app.pool.end(), authPool.end()]);
  });
  return { owner, app, authPool, betterAuth };
}

export type ApiConnections = ReturnType<typeof apiConnections>;
export type FixtureUser = {
  userId: string;
  profileId: string;
  email: string;
  tenantId: string | null;
};
export type Fixture = {
  a: FixtureUser;
  a2: FixtureUser;
  b: FixtureUser;
  admin: FixtureUser;
  otherAdmin: FixtureUser;
  orphan: FixtureUser;
  prefix: string;
};

export async function createFixture(
  connections: ApiConnections,
  prefix = randomUUID(),
): Promise<Fixture> {
  const tenantA = `ffffffff-${prefix.slice(9)}`;
  const tenantB = `00000000-${prefix.slice(9)}`;
  const codePrefix = prefix.replaceAll('-', '');
  const hash = await (
    await connections.betterAuth.$context
  ).password.hash(password);
  await connections.owner.pool.query(
    `INSERT INTO public.tenants(id,code,name,currency,overdraft_limit) VALUES ($1,$2,'Tenant A','CNY',100),($3,$4,'Tenant B','USD',100)`,
    [tenantA, `A${codePrefix}`, tenantB, `B${codePrefix}`],
  );
  async function user(
    label: string,
    kind: 'admin' | 'customer' | 'none',
    tenantId: string | null,
  ): Promise<FixtureUser> {
    const userId = `${prefix}-${label}`;
    const email = `${userId}@example.com`;
    const profileId = randomUUID();
    await connections.owner.pool.query(
      `INSERT INTO auth."user"(id,name,email) VALUES($1,$2,$3)`,
      [userId, label, email],
    );
    await connections.owner.pool.query(
      `INSERT INTO auth.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,$2,'credential',$2,$3,now()-interval '1 second')`,
      [randomUUID(), userId, hash],
    );
    if (kind === 'admin')
      await connections.owner.pool.query(
        `INSERT INTO public.admins(id,auth_user_id,name) VALUES($1,$2,$3)`,
        [profileId, userId, label],
      );
    if (kind === 'customer')
      await connections.owner.pool.query(
        `INSERT INTO public.portal_accounts(id,auth_user_id,tenant_id) VALUES($1,$2,$3)`,
        [profileId, userId, tenantId],
      );
    return { userId, profileId, email, tenantId };
  }
  const fixture = {
    a: await user('a', 'customer', tenantA),
    a2: await user('a2', 'customer', tenantA),
    b: await user('b', 'customer', tenantB),
    admin: await user('admin', 'admin', null),
    otherAdmin: await user('other-admin', 'admin', null),
    orphan: await user('orphan', 'none', null),
    prefix,
  };
  await withAdmin(connections.owner.db, (tx) =>
    appendLedgerEntries(tx, [
      {
        tenant: { id: tenantA, currency: 'CNY' },
        entry: {
          kind: 'recharge',
          amount: money('CNY', '111.25'),
          adminId: fixture.admin.profileId,
          note: 'API isolation fixture',
          idempotencyKey: `fixture:${prefix}:a`,
        },
      },
      {
        tenant: { id: tenantB, currency: 'USD' },
        entry: {
          kind: 'recharge',
          amount: money('USD', '999.75'),
          adminId: fixture.admin.profileId,
          note: 'API isolation fixture',
          idempotencyKey: `fixture:${prefix}:b`,
        },
      },
    ]),
  );
  return fixture;
}

export function fixtureApi(
  connections: ApiConnections,
  options: {
    ownerLane?: boolean;
    hooks?: AuthHooks;
    rateLimit?: { max: number; timeWindow: number };
  } = {},
) {
  const logs: object[] = [];
  const auth = createAuthGateway({
    pool: connections.authPool,
    secret: 'test-only-secret-with-at-least-32-characters',
    baseURL: origin,
    secureCookies: true,
    trustedOrigins: [origin],
    logger: {
      info: (fields) => {
        logs.push(fields);
      },
      error: (fields) => {
        logs.push(fields);
      },
    },
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const api = createApi({
    businessDb: options.ownerLane ? connections.owner.db : connections.app.db,
    auth,
    trustedOrigins: [origin],
    rateLimit: options.rateLimit ?? { max: 1000, timeWindow: 60_000 },
  });
  afterAll(() => api.close());
  return { api, auth, logs };
}

export function cookieFrom(response: {
  headers: { [key: string]: string | string[] | number | undefined };
}): string {
  const header = response.headers['set-cookie'];
  const cookies =
    typeof header === 'string' ? [header] : Array.isArray(header) ? header : [];
  const token = cookies.find((value) => value.includes('session_token='));
  if (!token) throw new Error('Expected a session_token Set-Cookie');
  return token.split(';')[0] ?? '';
}

export async function login(
  api: ReturnType<typeof createApi>,
  user: FixtureUser,
  inputPassword = password,
  remoteAddress = '127.0.0.1',
) {
  const response = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: user.email, password: inputPassword },
    remoteAddress,
  });
  if (response.statusCode !== 200)
    throw new Error(`Login failed ${response.statusCode}: ${response.body}`);
  return {
    cookie: cookieFrom(response),
    body: sessionResponseSchema.parse(response.json()),
    response,
  };
}

export function requestHeaders(cookie: string) {
  return { cookie, origin };
}
