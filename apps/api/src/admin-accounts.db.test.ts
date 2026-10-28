import {
  adminPortalAccountCreateResponseSchema,
  adminAccountCreateResponseSchema,
  adminAccountsResponseSchema,
  adminPortalAccountsResponseSchema,
  adminMutationResponseSchema,
  sessionResponseSchema,
  type AdminAccountsQuery,
} from '@fs-billing/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sql } from '@fs-billing/db';
import pg, { type PoolClient } from 'pg';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  cookieFrom,
  login,
  origin,
  password,
  requestHeaders,
  type Fixture,
} from '../test/support.js';
import { principalSchema } from './types.js';
import { createAuthGateway } from './auth/gateway.js';
import { createAdminAccountService } from './auth/admin-accounts.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
const service = createAdminAccountService({
  businessDb: connections.app.db,
  auth: connections.betterAuth,
});
let fixture: Fixture;
beforeAll(() => api.ready());
beforeEach(async () => {
  fixture = await createFixture(connections);
});
const principal = (user = fixture.admin) => {
  const value = principalSchema.parse({
    kind: 'admin',
    authUserId: user.userId,
    profileId: user.profileId,
  });
  if (value.kind !== 'admin') throw new Error('Expected admin');
  return value;
};
async function post(url: string, payload = {}) {
  const session = await login(api, fixture.admin);
  return api.inject({
    method: 'POST',
    url,
    headers: requestHeaders(session.cookie),
    payload,
  });
}

it('creates admins with a same-transaction audit and initial temporary credential', async () => {
  const email = `${randomUUID()}@example.com`;
  const response = await post('/api/admin/admins', {
    name: 'New admin',
    email,
  });
  expect(response.statusCode).toBe(200);
  const body = adminAccountCreateResponseSchema.parse(response.json());
  expect(body.account).toMatchObject({
    name: 'New admin',
    email,
    status: 'active',
  });
  expect(body.account).not.toHaveProperty('authUserId');
  const events = await connections.owner.pool.query(
    'SELECT action FROM public.operation_logs WHERE id=$1',
    [body.auditId],
  );
  expect(events.rows).toEqual([{ action: 'admin_create' }]);
  const credential = await connections.owner.pool.query<{
    temporary_password_issued_at: Date;
  }>(
    'SELECT a.temporary_password_issued_at FROM auth.account a JOIN auth."user" u ON u.id=a.user_id WHERE u.email=$1',
    [email],
  );
  expect(credential.rows[0]?.temporary_password_issued_at).toBeInstanceOf(Date);
  const signed = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email, password: body.temporaryPassword },
  });
  expect(signed.statusCode).toBe(200);
  const duplicate = await post('/api/admin/admins', {
    name: 'Duplicate',
    email,
  });
  expect(duplicate.statusCode).toBe(409);
  expect(duplicate.json()).toMatchObject({ error: { code: 'EMAIL_EXISTS' } });
});

it('maps duplicate portal account conflicts to the declared contract', async () => {
  const portal = await post(
    `/api/admin/tenants/${fixture.a.tenantId}/portal-accounts`,
    { email: `${randomUUID()}@example.com` },
  );
  expect(portal.statusCode).toBe(409);
  expect(portal.json()).toMatchObject({
    error: { code: 'PORTAL_ACCOUNT_EXISTS' },
  });
});

it('lists auth email through private lookup without leaking internal ids', async () => {
  const session = await login(api, fixture.admin);
  const response = await api.inject({
    method: 'GET',
    url: `/api/admin/admins?search=${encodeURIComponent(fixture.admin.email)}`,
    headers: requestHeaders(session.cookie),
  });
  expect(response.statusCode).toBe(200);
  expect(adminAccountsResponseSchema.parse(response.json()).items).toEqual([
    expect.objectContaining({
      id: fixture.admin.profileId,
      email: fixture.admin.email,
    }),
  ]);
  expect(
    adminAccountsResponseSchema.parse(response.json()).items[0],
  ).not.toHaveProperty('authUserId');
  const portal = await api.inject({
    method: 'GET',
    url: `/api/admin/tenants/${fixture.a.tenantId}/portal-accounts`,
    headers: requestHeaders(session.cookie),
  });
  expect(portal.statusCode).toBe(200);
  expect(adminPortalAccountsResponseSchema.parse(portal.json()).items).toEqual([
    expect.objectContaining({
      id: fixture.a.profileId,
      email: fixture.a.email,
    }),
  ]);
});

it('lists admins in one joined read with stable query count, search, order and pagination', async () => {
  const marker = randomUUID();
  const createdAt = new Date('2026-01-01T00:00:00.000Z');
  const lastLoginAt = new Date('2026-01-02T00:00:00.000Z');
  const expected = [];
  async function add(index: number) {
    const id = randomUUID();
    const userId = randomUUID();
    const email = `${marker}-${index}@example.com`;
    const status = index === 2 ? 'disabled' : 'active';
    const name =
      index === 3 ? 'Name matches email search' : `Admin ${marker} ${index}`;
    await connections.owner.pool.query(
      'INSERT INTO auth."user"(id,name,email) VALUES($1,$2,$3)',
      [userId, name, email],
    );
    await connections.owner.pool.query(
      'INSERT INTO public.admins(id,auth_user_id,name,status,created_at,last_login_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id, userId, name, status, createdAt, index === 0 ? lastLoginAt : null],
    );
    return {
      id,
      email,
      name,
      status,
      createdAt: createdAt.toISOString(),
      lastLoginAt: index === 0 ? lastLoginAt.toISOString() : null,
    };
  }
  async function observedList(
    query: AdminAccountsQuery = {
      search: marker.toUpperCase(),
      page: 1,
      pageSize: 100,
    },
  ) {
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    const authQueries = vi.spyOn(connections.authPool, 'query');
    try {
      const result = await service.listAdmins(query);
      expect(authQueries).not.toHaveBeenCalled();
      const texts = queries.mock.calls.map(([query]) =>
        z
          .union([
            z.string(),
            z.object({ text: z.string() }).transform((value) => value.text),
          ])
          .parse(query),
      );
      expect(
        texts.filter((text) => text.includes('lookup_user_emails')),
      ).toHaveLength(1);
      return { result, queryCount: queries.mock.calls.length };
    } finally {
      queries.mockRestore();
      authQueries.mockRestore();
    }
  }
  expected.push(await add(0));
  const one = await observedList();
  expect(one.result).toEqual({
    items: expected,
    pagination: { page: 1, pageSize: 100, total: 1 },
  });
  for (const index of [1, 2, 3]) expected.push(await add(index));
  expected.sort((left, right) => left.id.localeCompare(right.id));
  const many = await observedList();
  expect(many.queryCount).toBe(one.queryCount);
  expect(many.result).toEqual({
    items: expected,
    pagination: { page: 1, pageSize: 100, total: 4 },
  });
  const active = await observedList({
    search: marker,
    status: 'active',
    page: 2,
    pageSize: 1,
  });
  expect(active.queryCount).toBe(one.queryCount);
  expect(active.result).toEqual({
    items: expected.filter((row) => row.status === 'active').slice(1, 2),
    pagination: { page: 2, pageSize: 1, total: 3 },
  });
  const disabled = await observedList({
    search: marker,
    status: 'disabled',
    page: 1,
    pageSize: 20,
  });
  expect(disabled.queryCount).toBe(one.queryCount);
  expect(disabled.result).toEqual({
    items: expected.filter((row) => row.status === 'disabled'),
    pagination: { page: 1, pageSize: 20, total: 1 },
  });
});

it('lists zero or one portal account without separate auth queries and preserves tenant isolation', async () => {
  const tenantId = randomUUID();
  await connections.owner.pool.query(
    "INSERT INTO public.tenants(id,code,name,currency,overdraft_limit) VALUES($1,$2,'No portal','CNY',0)",
    [tenantId, `empty${tenantId.replaceAll('-', '')}`],
  );
  async function observedList(id: string) {
    const queries = vi.spyOn(pg.Client.prototype, 'query');
    const authQueries = vi.spyOn(connections.authPool, 'query');
    try {
      const result = await service.listPortal(id);
      expect(authQueries).not.toHaveBeenCalled();
      return { result, queryCount: queries.mock.calls.length };
    } finally {
      queries.mockRestore();
      authQueries.mockRestore();
    }
  }
  const empty = await observedList(tenantId);
  expect(empty.result).toEqual({ items: [] });
  for (const user of [fixture.a, fixture.b]) {
    if (!user.tenantId) throw new Error('Expected portal tenant');
    const listed = await observedList(user.tenantId);
    expect(listed.queryCount).toBe(empty.queryCount);
    const stored = await connections.owner.pool.query<{
      status: string;
      last_login_at: Date | null;
      created_at: Date;
    }>(
      'SELECT status,last_login_at,created_at FROM public.portal_accounts WHERE id=$1',
      [user.profileId],
    );
    const row = stored.rows[0];
    if (!row) throw new Error('Expected portal fixture');
    expect(listed.result).toEqual({
      items: [
        {
          id: user.profileId,
          email: user.email,
          status: row.status,
          lastLoginAt: row.last_login_at?.toISOString() ?? null,
          createdAt: row.created_at.toISOString(),
        },
      ],
    });
  }
  await expect(service.listPortal(randomUUID())).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});

it('batch email lookup keeps auth tables private and requires admin scope', async () => {
  await expect(
    connections.app.pool.query('SELECT email FROM auth."user"'),
  ).rejects.toMatchObject({ code: '42501' });
  expect(
    (
      await connections.app.pool.query(
        'SELECT * FROM auth.lookup_user_emails(ARRAY[$1::text])',
        [fixture.admin.userId],
      )
    ).rows,
  ).toEqual([]);
});

it('portal disable and enable audit without changing tenant status or restoring old sessions', async () => {
  const old = await login(api, fixture.a);
  const disabled = await post(
    `/api/admin/portal-accounts/${fixture.a.profileId}/disable`,
  );
  expect(disabled.statusCode).toBe(200);
  await connections.owner.pool.query(
    "UPDATE public.tenants SET status='disabled' WHERE id=$1",
    [fixture.a.tenantId],
  );
  const enabled = await post(
    `/api/admin/portal-accounts/${fixture.a.profileId}/enable`,
  );
  expect(enabled.statusCode).toBe(200);
  const tenant = await connections.owner.pool.query(
    'SELECT status FROM public.tenants WHERE id=$1',
    [fixture.a.tenantId],
  );
  expect(tenant.rows).toEqual([{ status: 'disabled' }]);
  const stale = await api.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: requestHeaders(old.cookie),
  });
  expect(stale.statusCode).toBe(401);
  const events = await connections.owner.pool.query(
    'SELECT action FROM public.operation_logs WHERE id=ANY($1::uuid[]) ORDER BY action',
    [
      [
        adminMutationResponseSchema.parse(disabled.json()).auditId,
        adminMutationResponseSchema.parse(enabled.json()).auditId,
      ],
    ],
  );
  expect(events.rows).toEqual([
    { action: 'portal_account_disable' },
    { action: 'portal_account_enable' },
  ]);
});

it('temporary credentials reject after expiry and permanent password changes clear issuance', async () => {
  for (const user of [fixture.admin, fixture.a]) {
    await connections.owner.pool.query(
      "UPDATE auth.account SET temporary_password_issued_at=clock_timestamp()-interval '73 hours' WHERE user_id=$1",
      [user.userId],
    );
    const denied = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: user.email, password },
    });
    expect(denied.statusCode).toBe(401);
    await connections.owner.pool.query(
      'UPDATE auth.account SET temporary_password_issued_at=clock_timestamp() WHERE user_id=$1',
      [user.userId],
    );
    const session = await login(api, user);
    const changed = await api.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: requestHeaders(session.cookie),
      payload: {
        currentPassword: password,
        newPassword: 'Changed-password-47',
      },
    });
    expect(changed.statusCode).toBe(200);
    const credential = await connections.owner.pool.query(
      'SELECT temporary_password_issued_at FROM auth.account WHERE user_id=$1',
      [user.userId],
    );
    expect(credential.rows).toEqual([{ temporary_password_issued_at: null }]);
  }
});

it('failed account creation rolls back the auth user and writes no audit', async () => {
  const missingEmail = `${randomUUID()}@example.com`;
  const takenEmail = `${randomUUID()}@example.com`;
  await expect(
    service.createPortal(principal(), randomUUID(), { email: missingEmail }),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  const existingTenantId = fixture.a.tenantId;
  expect(existingTenantId).toEqual(expect.any(String));
  await expect(
    service.createPortal(principal(), existingTenantId!, {
      email: takenEmail,
    }),
  ).rejects.toMatchObject({ code: 'PORTAL_ACCOUNT_EXISTS' });
  const users = await connections.owner.pool.query(
    'SELECT email FROM auth."user" WHERE email = ANY($1)',
    [[missingEmail, takenEmail]],
  );
  expect(users.rows).toEqual([]);
  const audits = await connections.owner.pool.query(
    `SELECT id FROM public.operation_logs WHERE details->'content'->>'email' = ANY($1)`,
    [[missingEmail, takenEmail]],
  );
  expect(audits.rows).toEqual([]);
  const denied = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: missingEmail, password },
  });
  expect(denied.statusCode).toBe(401);
});

it('customers cannot list or mutate admin or portal accounts', async () => {
  const session = await login(api, fixture.a);
  const paths = [
    '/api/admin/admins',
    `/api/admin/admins/${fixture.otherAdmin.profileId}/enable`,
    `/api/admin/admins/${fixture.otherAdmin.profileId}/disable`,
    `/api/admin/tenants/${fixture.b.tenantId}/portal-accounts`,
    `/api/admin/portal-accounts/${fixture.b.profileId}/disable`,
    `/api/admin/portal-accounts/${fixture.b.profileId}/enable`,
  ];
  for (const path of paths) {
    const response = await api.inject({
      method:
        path.endsWith('accounts') || path.endsWith('admins') ? 'GET' : 'POST',
      url: path,
      headers: requestHeaders(session.cookie),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
  }
});

it('creates generated and supplied portal credentials without exposing supplied passwords', async () => {
  for (const supplied of [false, true]) {
    const tenantId = randomUUID();
    await connections.owner.pool.query(
      "INSERT INTO public.tenants(id,code,name,currency,overdraft_limit) VALUES($1,$2,'Portal creation','CNY',0)",
      [tenantId, `PORTAL${tenantId.replaceAll('-', '')}`],
    );
    const email = `${randomUUID()}@example.com`;
    const response = await post(
      `/api/admin/tenants/${tenantId}/portal-accounts`,
      supplied ? { email, initialPassword: password } : { email },
    );
    expect(response.statusCode).toBe(200);
    const body: unknown = response.json();
    const parsed = adminPortalAccountCreateResponseSchema.parse(body);
    expect(parsed.account.email).toBe(email);
    expect(parsed.passwordSource).toBe(supplied ? 'supplied' : 'generated');
    if (supplied) expect(body).not.toHaveProperty('temporaryPassword');
    const activePassword =
      parsed.passwordSource === 'generated'
        ? parsed.temporaryPassword
        : password;
    const signed = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email, password: activePassword },
    });
    expect(signed.statusCode).toBe(200);
    const events = await connections.owner.pool.query(
      'SELECT action,tenant_id FROM public.operation_logs WHERE id=$1',
      [parsed.auditId],
    );
    expect(events.rows).toEqual([
      { action: 'portal_account_create', tenant_id: tenantId },
    ]);
  }
});

it('enforces configured temporary credential TTL for admin and portal logins', async () => {
  const custom = createAuthGateway({
    pool: connections.authPool,
    secret: 'test-only-secret-with-at-least-32-characters',
    baseURL: origin,
    secureCookies: true,
    trustedOrigins: [origin],
    logger: { info() {}, error() {} },
    temporaryPasswordTtlMs: 60_000,
  });
  for (const user of [fixture.admin, fixture.a]) {
    await connections.owner.pool.query(
      "UPDATE auth.account SET temporary_password_issued_at=clock_timestamp()-interval '61 seconds' WHERE user_id=$1",
      [user.userId],
    );
    await expect(
      custom.login({ email: user.email, password }, new Headers()),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    await connections.owner.pool.query(
      'UPDATE auth.account SET temporary_password_issued_at=clock_timestamp() WHERE user_id=$1',
      [user.userId],
    );
    const signed = await custom.login(
      { email: user.email, password },
      new Headers(),
    );
    expect(signed.authUserId).toBe(user.userId);
    await custom.discardSession(signed.token);
  }
});

it('blocks business routes until a temporary password is changed', async () => {
  const email = `${randomUUID()}@example.com`;
  const created = await post('/api/admin/admins', {
    name: 'Temporary',
    email,
  });
  expect(created.statusCode).toBe(200);
  const body = adminAccountCreateResponseSchema.parse(created.json());
  const signed = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email, password: body.temporaryPassword },
  });
  expect(signed.statusCode).toBe(200);
  expect(
    sessionResponseSchema.parse(signed.json()).passwordChangeRequired,
  ).toBe(true);
  const cookie = cookieFrom(signed);
  const blocked = await api.inject({
    url: '/api/admin/context',
    headers: requestHeaders(cookie),
  });
  expect(blocked.statusCode).toBe(403);
  expect(blocked.json()).toMatchObject({
    error: { code: 'PASSWORD_CHANGE_REQUIRED' },
  });
  const session = await api.inject({
    url: '/api/auth/session',
    headers: requestHeaders(cookie),
  });
  expect(session.statusCode).toBe(200);
  expect(
    sessionResponseSchema.parse(session.json()).passwordChangeRequired,
  ).toBe(true);
  const changed = await api.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: requestHeaders(cookie),
    payload: {
      currentPassword: body.temporaryPassword,
      newPassword: 'Changed-password-47',
    },
  });
  expect(changed.statusCode).toBe(200);
  expect(
    sessionResponseSchema.parse(changed.json()).passwordChangeRequired,
  ).toBe(false);
  const allowed = await api.inject({
    url: '/api/admin/context',
    headers: requestHeaders(cookieFrom(changed)),
  });
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json()).toEqual({
    identity: {
      kind: 'admin',
      profileId: body.account.id,
      name: 'Temporary',
      email,
    },
  });
});

it('unchanged account status returns no audit id', async () => {
  const response = await post(
    `/api/admin/admins/${fixture.admin.profileId}/enable`,
  );
  expect(response.statusCode).toBe(200);
  expect(adminMutationResponseSchema.parse(response.json())).toEqual({
    auditId: null,
  });
});

it('rejects self-disable and records disable audit with session revoke', async () => {
  const self = await post(
    `/api/admin/admins/${fixture.admin.profileId}/disable`,
  );
  expect(self.statusCode).toBe(409);
  expect(self.json()).toMatchObject({ error: { code: 'SELF_DISABLE' } });
  const old = await login(api, fixture.otherAdmin);
  const disabled = await post(
    `/api/admin/admins/${fixture.otherAdmin.profileId}/disable`,
  );
  expect(disabled.statusCode).toBe(200);
  const events = await connections.owner.pool.query(
    'SELECT action FROM public.operation_logs WHERE id=$1',
    [adminMutationResponseSchema.parse(disabled.json()).auditId],
  );
  expect(events.rows).toEqual([{ action: 'admin_disable' }]);
  const stale = await api.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: requestHeaders(old.cookie),
  });
  expect(stale.statusCode).toBe(401);
});

it('admin enable audits without restoring sessions', async () => {
  const old = await login(api, fixture.otherAdmin);
  await connections.owner.pool.query(
    "UPDATE public.admins SET status='disabled' WHERE id=$1",
    [fixture.otherAdmin.profileId],
  );
  const response = await post(
    `/api/admin/admins/${fixture.otherAdmin.profileId}/enable`,
  );
  expect(response.statusCode).toBe(200);
  const events = await connections.owner.pool.query(
    'SELECT action FROM public.operation_logs WHERE id=$1',
    [adminMutationResponseSchema.parse(response.json()).auditId],
  );
  expect(events.rows).toEqual([{ action: 'admin_enable' }]);
  const stale = await api.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: requestHeaders(old.cookie),
  });
  expect(stale.statusCode).toBe(401);
  await expect(login(api, fixture.otherAdmin)).resolves.toBeDefined();
});

async function backendPid(client: PoolClient) {
  const result = await client.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const row = result.rows[0];
  if (!row) throw new Error('Backend PID missing');
  return row.pid;
}

async function waitForBlocked(holderPid: number, count: number) {
  await expect
    .poll(
      async () => {
        const result = await connections.owner.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [holderPid],
        );
        return result.rows[0]?.n;
      },
      { timeout: 10_000 },
    )
    .toBe(count);
}

it('rejects uppercase own UUIDs for self-disable and self-reset', async () => {
  for (const [action, code] of [
    ['disable', 'SELF_DISABLE'],
    ['reset-password', 'FORBIDDEN'],
  ]) {
    const response = await post(
      `/api/admin/admins/${fixture.admin.profileId.toUpperCase()}/${action}`,
    );
    expect(response.statusCode).toBe(action === 'disable' ? 409 : 403);
    expect(response.json()).toMatchObject({ error: { code } });
  }
  const state = await connections.owner.pool.query(
    'SELECT status FROM public.admins WHERE id=$1',
    [fixture.admin.profileId],
  );
  expect(state.rows).toEqual([{ status: 'active' }]);
  const audit = await connections.owner.pool.query(
    "SELECT action FROM public.operation_logs WHERE target=$1 AND action IN ('admin_disable','reset_password')",
    [fixture.admin.profileId],
  );
  expect(audit.rows).toEqual([]);
});

it('refuses one of two concurrent mutual admin disables and audits only the committed change', async () => {
  const others = await connections.owner.pool.query<{ id: string }>(
    "UPDATE public.admins SET status='disabled' WHERE status='active' AND id <> ALL($1::uuid[]) RETURNING id",
    [[fixture.admin.profileId, fixture.otherAdmin.profileId]],
  );
  let releaseSnapshots = () => {};
  const snapshotsReady = new Promise<void>((resolve) => {
    releaseSnapshots = resolve;
  });
  let releaseLoser = () => {};
  const winnerCommitted = new Promise<void>((resolve) => {
    releaseLoser = resolve;
  });
  const transaction = connections.app.db.transaction.bind(connections.app.db);
  let deadlineFailure: Error | undefined;
  async function withDeadline<T>(
    operation: Promise<T>,
    message: string,
    timeoutMs = 2_000,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            deadlineFailure ??= new Error(message);
            reject(deadlineFailure);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let attempts = 0;
  let snapshots = 0;
  const failures: unknown[] = [];
  const transactions = vi
    .spyOn(connections.app.db, 'transaction')
    .mockImplementation(async (fn, config) => {
      const attempt = ++attempts;
      try {
        const result = await transaction(async (tx) => {
          await tx.execute(
            sql`select set_config('statement_timeout', '2s', true)`,
          );
          if (attempt <= 2) {
            await tx.execute(
              sql`select set_config('app.scope', 'admin', true)`,
            );
            // Both SSI snapshots read both admins before the winner writes.
            await tx.execute(
              sql`select count(*) from public.admins where status = 'active'`,
            );
            if (++snapshots === 2) releaseSnapshots();
            await withDeadline(
              snapshotsReady,
              'Timed out waiting for both admin-disable snapshots',
            );
            // The stale loser must abort, then retry against the committed winner.
            if (attempt === 2)
              await withDeadline(
                winnerCommitted,
                'Timed out waiting for the winning admin-disable transaction',
              );
          }
          return fn(tx);
        }, config);
        return result;
      } catch (error) {
        failures.push(error);
        releaseSnapshots();
        throw error;
      } finally {
        if (attempt === 1) releaseLoser();
      }
    });
  let pending:
    Promise<PromiseSettledResult<{ auditId: string | null }>[]> | undefined;
  try {
    pending = Promise.allSettled([
      service.setStatus(principal(), {
        kind: 'admin',
        id: fixture.otherAdmin.profileId,
        status: 'disabled',
      }),
      service.setStatus(principal(fixture.otherAdmin), {
        kind: 'admin',
        id: fixture.admin.profileId,
        status: 'disabled',
      }),
    ]);
    const results = await withDeadline(
      pending,
      'Timed out waiting for concurrent admin disables to settle',
      6_000,
    );
    if (deadlineFailure) throw deadlineFailure;
    expect(attempts).toBe(3);
    expect(failures).toMatchObject([
      { cause: { code: '40001' } },
      { code: 'FORBIDDEN' },
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toMatchObject([{ reason: { code: 'FORBIDDEN' } }]);
    const statuses = await connections.owner.pool.query(
      'SELECT status FROM public.admins WHERE id=ANY($1::uuid[]) ORDER BY status',
      [[fixture.admin.profileId, fixture.otherAdmin.profileId]],
    );
    expect(statuses.rows).toEqual([
      { status: 'active' },
      { status: 'disabled' },
    ]);
    expect(
      (
        await connections.owner.pool.query(
          "SELECT count(*)::int AS active FROM public.admins WHERE status='active'",
        )
      ).rows,
    ).toEqual([{ active: 1 }]);
    const audits = await connections.owner.pool.query(
      "SELECT action FROM public.operation_logs WHERE target=ANY($1::text[]) AND action='admin_disable'",
      [[fixture.admin.profileId, fixture.otherAdmin.profileId]],
    );
    expect(audits.rows).toEqual([{ action: 'admin_disable' }]);
  } finally {
    releaseSnapshots();
    releaseLoser();
    transactions.mockRestore();
    try {
      if (pending)
        await withDeadline(
          pending,
          'Timed out cleaning up concurrent admin-disable transactions',
          3_000,
        );
    } finally {
      const restoreAdmins = {
        text: "UPDATE public.admins SET status='active' WHERE id=ANY($1::uuid[])",
        values: [others.rows.map((row) => row.id)],
        query_timeout: 2_000,
      };
      await connections.owner.pool.query(restoreAdmins);
    }
  }
});

it('concurrent duplicate portal disables reread after the tenant lock and write one audit', async () => {
  const holder = await connections.owner.pool.connect();
  let pending: Promise<{ auditId: string | null }[]> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.scope','admin',true)");
    const pid = await backendPid(holder);
    await holder.query('SELECT lock_tenants(ARRAY[$1::uuid])', [
      fixture.a.tenantId,
    ]);
    pending = Promise.all(
      [1, 2].map(() =>
        service.setStatus(principal(), {
          kind: 'portal',
          id: fixture.a.profileId,
          status: 'disabled',
        }),
      ),
    );
    await waitForBlocked(pid, 2);
    await holder.query('COMMIT');
    const results = await pending;
    expect(results.filter((result) => result.auditId !== null)).toHaveLength(1);
    const audits = await connections.owner.pool.query(
      "SELECT action FROM public.operation_logs WHERE target=$1 AND action='portal_account_disable'",
      [fixture.a.profileId],
    );
    expect(audits.rows).toEqual([{ action: 'portal_account_disable' }]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending;
  }
});

it('portal enable rereads a status changed while waiting for its tenant lock', async () => {
  const holder = await connections.owner.pool.connect();
  let pending: ReturnType<typeof service.setStatus> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.scope','admin',true)");
    const pid = await backendPid(holder);
    await holder.query('SELECT lock_tenants(ARRAY[$1::uuid])', [
      fixture.a.tenantId,
    ]);
    pending = service.setStatus(principal(), {
      kind: 'portal',
      id: fixture.a.profileId,
      status: 'active',
    });
    await waitForBlocked(pid, 1);
    await holder.query(
      "UPDATE public.portal_accounts SET status='disabled' WHERE id=$1",
      [fixture.a.profileId],
    );
    await holder.query('COMMIT');
    expect((await pending).auditId).toEqual(expect.any(String));
    const state = await connections.owner.pool.query(
      'SELECT status FROM public.portal_accounts WHERE id=$1',
      [fixture.a.profileId],
    );
    expect(state.rows).toEqual([{ status: 'active' }]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending;
  }
});

it('resets admin and portal credentials through the administrator transaction without querying the auth pool', async () => {
  for (const kind of ['admin', 'portal'] as const) {
    const user = kind === 'admin' ? fixture.otherAdmin : fixture.a;
    const session = await login(api, user);
    await connections.owner.pool.query(
      'INSERT INTO auth.login_failures(email_key,window_id,failed_count,last_failed_at) VALUES($1,gen_random_uuid(),1,now())',
      [user.email.toLowerCase()],
    );
    const authQueries = vi.spyOn(connections.authPool, 'query');
    let temporaryPassword: string;
    try {
      ({ temporaryPassword } = await service.resetPassword(
        principal(),
        kind,
        user.profileId,
      ));
      expect(authQueries).not.toHaveBeenCalled();
    } finally {
      authQueries.mockRestore();
    }
    const context = await connections.betterAuth.$context;
    const credential = await connections.owner.pool.query<{
      password: string;
      temporary_password_issued_at: Date;
    }>(
      "SELECT password,temporary_password_issued_at FROM auth.account WHERE user_id=$1 AND provider_id='credential'",
      [user.userId],
    );
    const row = credential.rows[0];
    if (!row) throw new Error('Expected credential');
    expect(row.temporary_password_issued_at).toBeInstanceOf(Date);
    expect(
      await context.password.verify({
        hash: row.password,
        password: temporaryPassword,
      }),
    ).toBe(true);
    expect(
      (
        await connections.owner.pool.query(
          'SELECT email_key FROM auth.login_failures WHERE email_key=$1',
          [user.email.toLowerCase()],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await connections.owner.pool.query(
          "SELECT tenant_id,action FROM public.operation_logs WHERE target=$1 AND action='reset_password'",
          [user.profileId],
        )
      ).rows,
    ).toEqual([
      {
        tenant_id: kind === 'portal' ? fixture.a.tenantId : null,
        action: 'reset_password',
      },
    ]);
    const stale = await api.inject({
      url: '/api/auth/session',
      headers: requestHeaders(session.cookie),
    });
    expect(stale.statusCode).toBe(401);
  }
});

it('portal password reset waits for its tenant lock before changing credentials or revoking sessions', async () => {
  const session = await login(api, fixture.a);
  const before = await connections.owner.pool.query(
    'SELECT password FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const holder = await connections.owner.pool.connect();
  let pending: ReturnType<typeof service.resetPassword> | undefined;
  try {
    await holder.query('BEGIN');
    await holder.query("SELECT set_config('app.scope','admin',true)");
    const pid = await backendPid(holder);
    await holder.query('SELECT lock_tenants(ARRAY[$1::uuid])', [
      fixture.a.tenantId,
    ]);
    pending = service.resetPassword(principal(), 'portal', fixture.a.profileId);
    await waitForBlocked(pid, 1);
    expect(
      (
        await connections.owner.pool.query(
          'SELECT password FROM auth.account WHERE user_id=$1',
          [fixture.a.userId],
        )
      ).rows,
    ).toEqual(before.rows);
    const active = await api.inject({
      url: '/api/auth/session',
      headers: requestHeaders(session.cookie),
    });
    expect(active.statusCode).toBe(200);
    expect(
      (
        await connections.owner.pool.query(
          "SELECT id FROM public.operation_logs WHERE target=$1 AND action='reset_password'",
          [fixture.a.profileId],
        )
      ).rows,
    ).toEqual([]);
    await holder.query('COMMIT');
    const reset = await pending;
    const stale = await api.inject({
      url: '/api/auth/session',
      headers: requestHeaders(session.cookie),
    });
    expect(stale.statusCode).toBe(401);
    const signed = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: fixture.a.email, password: reset.temporaryPassword },
    });
    expect(signed.statusCode).toBe(200);
    expect(
      (
        await connections.owner.pool.query(
          "SELECT action FROM public.operation_logs WHERE target=$1 AND action='reset_password'",
          [fixture.a.profileId],
        )
      ).rows,
    ).toEqual([{ action: 'reset_password' }]);
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
    await pending;
  }
});

/**
 * 阶段 8 延后项 1（决定 40）：重置密码的凭据、会话撤销与审计在同一个事务里。
 * 审计写不进去时整个重置回滚（没有「已重置而无审计」），并另起事务写一条 audit_failed 告警。
 * 用 owner 在 operation_logs 上建触发器，只让这一个目标的 reset_password 审计失败。
 */
async function failingResetAudit(target: string) {
  const name = `reset_audit_failure_${randomUUID().replaceAll('-', '')}`;
  await connections.owner.pool.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='reset_password' AND NEW.target='${target}' THEN RAISE EXCEPTION 'Injected audit failure'; END IF; RETURN NEW; END $$`,
  );
  await connections.owner.pool.query(
    `CREATE TRIGGER ${name} BEFORE INSERT ON public.operation_logs FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
  );
  return async () => {
    await connections.owner.pool.query(
      `DROP TRIGGER IF EXISTS ${name} ON public.operation_logs`,
    );
    await connections.owner.pool.query(`DROP FUNCTION public.${name}()`);
  };
}
const auditAlerts = async (needle: string) =>
  (
    await connections.owner.pool.query<{
      kind: string;
      description: string;
      tenant_id: string | null;
      recovered_at: Date | null;
    }>(
      `SELECT kind,description,tenant_id,recovered_at FROM public.system_alerts
       WHERE kind='audit_failed' AND description LIKE $1`,
      [`%${needle}%`],
    )
  ).rows;

it('a failed audit write rolls the reset back and leaves credentials and sessions unchanged', async () => {
  const session = await login(api, fixture.a);
  const before = await connections.owner.pool.query(
    'SELECT password FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const cleanup = await failingResetAudit(fixture.a.profileId);
  try {
    await expect(
      service.resetPassword(principal(), 'portal', fixture.a.profileId),
    ).rejects.toMatchObject({
      cause: { message: 'Injected audit failure' },
    });
  } finally {
    await cleanup();
  }
  expect(
    (
      await connections.owner.pool.query(
        'SELECT password FROM auth.account WHERE user_id=$1',
        [fixture.a.userId],
      )
    ).rows,
  ).toEqual(before.rows);
  const active = await api.inject({
    url: '/api/auth/session',
    headers: requestHeaders(session.cookie),
  });
  expect(active.statusCode).toBe(200);
  expect(
    (
      await connections.owner.pool.query(
        "SELECT id FROM public.operation_logs WHERE target=$1 AND action='reset_password'",
        [fixture.a.profileId],
      )
    ).rows,
  ).toEqual([]);
  await login(api, fixture.a);
});

it('a failed audit write opens one audit_failed alert without secrets', async () => {
  const cleanup = await failingResetAudit(fixture.a.profileId);
  const logged: object[] = [];
  const failing = createAdminAccountService({
    businessDb: connections.app.db,
    auth: connections.betterAuth,
    logger: { error: (fields: object) => void logged.push(fields) },
  });
  try {
    await expect(
      failing.resetPassword(principal(), 'portal', fixture.a.profileId),
    ).rejects.toMatchObject({
      cause: { message: 'Injected audit failure' },
    });
  } finally {
    await cleanup();
  }
  const alerts = await auditAlerts(fixture.a.profileId);
  expect(alerts).toHaveLength(1);
  expect(alerts[0]).toMatchObject({
    kind: 'audit_failed',
    tenant_id: fixture.a.tenantId,
    recovered_at: null,
  });
  // 只有动作与对象 id：没有邮箱、密码、哈希或异常原文。
  for (const secret of [
    fixture.a.email,
    'Injected',
    'password',
    '$argon',
    'scrypt',
  ])
    expect(alerts[0]?.description).not.toContain(secret);
  expect(logged).toEqual([]);

  // 其他失败（对象不存在）不是审计失败，不开告警。
  const missing = randomUUID();
  await expect(
    service.resetPassword(principal(), 'portal', missing),
  ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  expect(await auditAlerts(missing)).toEqual([]);
  // 审计成功的重置不开告警。
  await service.resetPassword(principal(), 'portal', fixture.a2.profileId);
  expect(await auditAlerts(fixture.a2.profileId)).toEqual([]);
});

it('a failed alert write only logs: the original error still reaches the caller', async () => {
  const cleanup = await failingResetAudit(fixture.a.profileId);
  const alertTrigger = `alert_failure_${randomUUID().replaceAll('-', '')}`;
  await connections.owner.pool.query(
    `CREATE FUNCTION public.${alertTrigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Injected alert failure'; END $$`,
  );
  await connections.owner.pool.query(
    `CREATE TRIGGER ${alertTrigger} BEFORE INSERT ON public.system_alerts FOR EACH ROW WHEN (NEW.kind='audit_failed') EXECUTE FUNCTION public.${alertTrigger}()`,
  );
  const logged: { event?: string }[] = [];
  const failing = createAdminAccountService({
    businessDb: connections.app.db,
    auth: connections.betterAuth,
    logger: { error: (fields: object) => void logged.push(fields) },
  });
  try {
    await expect(
      failing.resetPassword(principal(), 'portal', fixture.a.profileId),
    ).rejects.toMatchObject({
      cause: { message: 'Injected audit failure' },
    });
  } finally {
    await cleanup();
    await connections.owner.pool.query(
      `DROP TRIGGER IF EXISTS ${alertTrigger} ON public.system_alerts`,
    );
    await connections.owner.pool.query(
      `DROP FUNCTION public.${alertTrigger}()`,
    );
  }
  expect(logged).toMatchObject([{ event: 'audit.alert_failed' }]);
  expect(await auditAlerts(fixture.a.profileId)).toEqual([]);
});
