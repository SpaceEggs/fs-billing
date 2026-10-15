import {
  adminPortalAccountCreateResponseSchema,
  adminAccountCreateResponseSchema,
  adminAccountsResponseSchema,
  adminPortalAccountsResponseSchema,
  adminMutationResponseSchema,
  sessionResponseSchema,
} from '@fs-billing/shared';
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, expect, it } from 'vitest';
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
  authPool: connections.authPool,
  auth: connections.betterAuth,
});
let fixture: Fixture;
beforeAll(() => api.ready());
beforeEach(async () => {
  fixture = await createFixture(connections);
});
const principal = () => {
  const value = principalSchema.parse({
    kind: 'admin',
    authUserId: fixture.admin.userId,
    profileId: fixture.admin.profileId,
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
  await expect(
    service.createPortal(principal(), fixture.a.tenantId, {
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
