import { performance } from 'node:perf_hooks';
import { getAuthTables } from 'better-auth/db';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiContract,
  apiErrorSchema,
  resetPasswordResponseSchema,
  sessionResponseSchema,
} from '@fs-billing/shared';
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

const connections = apiConnections();
const { api, auth, logs } = fixtureApi(connections);
let fixture: Fixture;
beforeAll(() => api.ready());
beforeEach(async () => {
  fixture = await createFixture(connections);
});

async function failLogin(email: string, remoteAddress = '127.0.0.1') {
  return api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email, password: 'incorrect' },
    remoteAddress,
  });
}
async function counter(email: string) {
  const result = await connections.owner.pool.query<{
    window_id: string;
    failed_count: number;
    last_failed_at: Date;
    locked_until: Date | null;
  }>(
    `SELECT window_id,failed_count,last_failed_at,locked_until FROM auth.login_failures WHERE email_key=$1`,
    [email],
  );
  return result.rows[0];
}
function errorCode(response: { json(): unknown }) {
  return apiErrorSchema.parse(response.json()).error.code;
}
async function sessionCount(userId: string) {
  const { rows } = await connections.owner.pool.query<{ count: string }>(
    'SELECT count(*) FROM auth.session WHERE user_id=$1',
    [userId],
  );
  return Number(rows[0]?.count);
}
async function getSession(cookie: string) {
  return api.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: requestHeaders(cookie),
  });
}

it('logs real customers and admins in and returns only public identity plus a database-backed expiration', async () => {
  for (const [user, kind] of [
    [fixture.a, 'customer'],
    [fixture.admin, 'admin'],
  ] as const) {
    const result = await login(api, user);
    expect(result.body.identity.kind).toBe(kind);
    expect(result.body.identity.profileId).toBe(user.profileId);
    expect(result.body.identity.email).toBe(user.email);
    expect(result.body).not.toHaveProperty('token');
    expect(result.body.identity).not.toHaveProperty('authUserId');
    const cookie = result.response.headers['set-cookie'];
    expect(String(cookie)).toMatch(/HttpOnly/i);
    expect(String(cookie)).toMatch(/Secure/i);
    expect(String(cookie)).toMatch(/SameSite=Lax/i);
    const { rows } = await connections.owner.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM auth.session WHERE user_id=$1',
      [user.userId],
    );
    expect(rows).toHaveLength(1);
    expect(result.body.expiresAt).toBe(rows[0]?.expires_at.toISOString());
  }
});

it('normalizes email exactly as installed Better Auth and resets prior failures after a successful login', async () => {
  await failLogin(fixture.a.email);
  const response = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: fixture.a.email.toUpperCase(), password },
  });
  expect(response.statusCode).toBe(200);
  expect(sessionResponseSchema.parse(response.json()).identity.email).toBe(
    fixture.a.email,
  );
  expect((await counter(fixture.a.email))?.failed_count ?? 0).toBe(0);
});

it('returns identical invalid credentials for wrong passwords and unknown email, including timing parity', async () => {
  const knownDurations: number[] = [];
  const unknownDurations: number[] = [];
  const unknown = `unknown-${fixture.prefix}@example.com`;
  for (let n = 0; n < 4; n++) {
    let start = performance.now();
    const known = await failLogin(fixture.a.email);
    knownDurations.push(performance.now() - start);
    start = performance.now();
    const missing = await failLogin(unknown);
    unknownDurations.push(performance.now() - start);
    expect(known.statusCode).toBe(401);
    expect(missing.statusCode).toBe(401);
    const left = apiErrorSchema.parse(known.json()).error;
    const right = apiErrorSchema.parse(missing.json()).error;
    expect(left.code).toBe('INVALID_CREDENTIALS');
    expect(right.code).toBe(left.code);
    expect(right.message).toBe(left.message);
    expect(known.headers['set-cookie']).toBeUndefined();
    expect(missing.headers['set-cookie']).toBeUndefined();
  }
  const mean = (values: number[]) =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const knownMean = mean(knownDurations);
  const unknownMean = mean(unknownDurations);
  expect(Math.abs(knownMean - unknownMean)).toBeLessThan(
    Math.max(75, Math.max(knownMean, unknownMean) * 0.65),
  );
  expect((await counter(unknown))?.failed_count).toBe(4);
});

it('locks the fifth attempt for a fixed fifteen minutes and never verifies, increments, or extends during lock', async () => {
  for (let n = 1; n <= 5; n++) {
    const response = await failLogin(fixture.a.email, `127.0.0.${n}`);
    expect(response.statusCode).toBe(n === 5 ? 429 : 401);
    expect(errorCode(response)).toBe(
      n === 5 ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
    );
  }
  const locked = await counter(fixture.a.email);
  expect(locked?.failed_count).toBe(5);
  expect(locked?.locked_until).toBeInstanceOf(Date);
  const lockedResponse = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: fixture.a.email, password },
    remoteAddress: '127.0.0.77',
  });
  expect(lockedResponse.statusCode).toBe(429);
  const body = apiErrorSchema.parse(lockedResponse.json());
  if (body.error.code !== 'ACCOUNT_LOCKED')
    throw new Error('Expected account lock');
  expect(body.error.retryAfterSeconds).toBeGreaterThanOrEqual(899);
  expect(body.error.retryAfterSeconds).toBeLessThanOrEqual(900);
  expect(String(lockedResponse.headers['retry-after'])).toBe(
    String(body.error.retryAfterSeconds),
  );
  expect(await counter(fixture.a.email)).toEqual(locked);
  expect(await sessionCount(fixture.a.userId)).toBe(0);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'auth.account_locked',
      emailKey: fixture.a.email,
    }),
  );
  expect(JSON.stringify(logs)).not.toContain(password);
});

it('unknown emails obey the same fifth-attempt lock and fifteen-minute window', async () => {
  const email = `missing-${fixture.prefix}@example.com`;
  for (let n = 1; n <= 5; n++) {
    const response = await failLogin(email);
    expect(errorCode(response)).toBe(
      n === 5 ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
    );
  }
  await connections.owner.pool.query(
    `UPDATE auth.login_failures SET last_failed_at=now()-interval '16 minutes', locked_until=now()-interval '1 second' WHERE email_key=$1`,
    [email],
  );
  expect(errorCode(await failLogin(email))).toBe('INVALID_CREDENTIALS');
  expect((await counter(email))?.failed_count).toBe(1);
});

it('resets a stale failure window and caps concurrent reservations at five password verifications', async () => {
  await failLogin(fixture.a.email);
  await connections.owner.pool.query(
    `UPDATE auth.login_failures SET failed_count=4,last_failed_at=now()-interval '16 minutes' WHERE email_key=$1`,
    [fixture.a.email],
  );
  expect(errorCode(await failLogin(fixture.a.email))).toBe(
    'INVALID_CREDENTIALS',
  );
  expect((await counter(fixture.a.email))?.failed_count).toBe(1);
  await connections.owner.pool.query(
    'DELETE FROM auth.login_failures WHERE email_key=$1',
    [fixture.a.email],
  );
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      failLogin(fixture.a.email, `127.0.1.${i + 1}`),
    ),
  );
  expect(
    responses.filter((response) => response.statusCode === 401),
  ).toHaveLength(4);
  expect(
    responses.filter((response) => response.statusCode === 429),
  ).toHaveLength(8);
  expect((await counter(fixture.a.email))?.failed_count).toBe(5);
});

it('change-password shares login failures, changes the password and issues a new session while revoking all old devices', async () => {
  const first = await login(api, fixture.a);
  const second = await login(api, fixture.a);
  const unrelated = await login(api, fixture.b);
  await failLogin(fixture.a.email);
  const wrong = await api.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: requestHeaders(first.cookie),
    payload: {
      currentPassword: 'incorrect',
      newPassword: 'Changed-password-88',
    },
  });
  expect(errorCode(wrong)).toBe('INVALID_CREDENTIALS');
  expect((await counter(fixture.a.email))?.failed_count).toBe(2);
  const changed = await api.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: requestHeaders(first.cookie),
    payload: { currentPassword: password, newPassword: 'Changed-password-88' },
  });
  expect(changed.statusCode).toBe(200);
  const body = sessionResponseSchema.parse(changed.json());
  expect(body.identity.profileId).toBe(fixture.a.profileId);
  expect(await sessionCount(fixture.a.userId)).toBe(1);
  const { rows } = await connections.owner.pool.query<{ expires_at: Date }>(
    'SELECT expires_at FROM auth.session WHERE user_id=$1',
    [fixture.a.userId],
  );
  expect(body.expiresAt).toBe(rows[0]?.expires_at.toISOString());
  expect((await getSession(first.cookie)).statusCode).toBe(401);
  expect((await getSession(second.cookie)).statusCode).toBe(401);
  expect((await getSession(unrelated.cookie)).statusCode).toBe(200);
  const newCookie = cookieFrom(changed);
  expect(newCookie).not.toBe(first.cookie);
  expect((await getSession(newCookie)).statusCode).toBe(200);
  expect(errorCode(await failLogin(fixture.a.email))).toBe(
    'INVALID_CREDENTIALS',
  );
  await login(api, fixture.a, 'Changed-password-88');
});

it('a login lock also blocks a correct current password on change-password', async () => {
  const current = await login(api, fixture.a);
  for (let n = 0; n < 5; n++) await failLogin(fixture.a.email);
  const locked = await counter(fixture.a.email);
  const response = await api.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: requestHeaders(current.cookie),
    payload: { currentPassword: password, newPassword: 'Changed-password-99' },
  });
  expect(errorCode(response)).toBe('ACCOUNT_LOCKED');
  expect(await counter(fixture.a.email)).toEqual(locked);
});

it('revokes only the current user other sessions and accepts both bodyless POST and empty JSON', async () => {
  const current = await login(api, fixture.a);
  const other1 = await login(api, fixture.a);
  const other2 = await login(api, fixture.a);
  const unrelated = await login(api, fixture.b);
  const response = await api.inject({
    method: 'POST',
    url: '/api/auth/revoke-other-sessions',
    headers: requestHeaders(current.cookie),
  });
  expect(response.statusCode).toBe(204);
  expect(response.body).toBe('');
  expect((await getSession(current.cookie)).statusCode).toBe(200);
  expect((await getSession(other1.cookie)).statusCode).toBe(401);
  expect((await getSession(other2.cookie)).statusCode).toBe(401);
  expect((await getSession(unrelated.cookie)).statusCode).toBe(200);
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/auth/revoke-other-sessions',
        headers: requestHeaders(current.cookie),
        payload: {},
      })
    ).statusCode,
  ).toBe(204);
  expect(
    (
      await api.inject({
        method: 'POST',
        url: '/api/auth/revoke-other-sessions',
        headers: requestHeaders(current.cookie),
        payload: { tenantId: fixture.b.tenantId },
      })
    ).statusCode,
  ).toBe(400);
});

it('correct passwords reveal disabled or unavailable identities only after deleting the newly created session without cookies', async () => {
  await connections.owner.pool.query(
    `UPDATE public.portal_accounts SET status='disabled' WHERE id=$1`,
    [fixture.a.profileId],
  );
  for (const [user, code] of [
    [fixture.a, 'ACCOUNT_DISABLED'],
    [fixture.orphan, 'IDENTITY_UNAVAILABLE'],
  ] as const) {
    expect(errorCode(await failLogin(user.email))).toBe('INVALID_CREDENTIALS');
    const response = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: user.email, password },
    });
    expect(response.statusCode).toBe(403);
    expect(errorCode(response)).toBe(code);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await sessionCount(user.userId)).toBe(0);
  }
  await connections.owner.pool.query(
    'INSERT INTO public.admins(auth_user_id,name) VALUES($1,$2)',
    [fixture.b.userId, 'Ambiguous'],
  );
  const ambiguous = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: fixture.b.email, password },
  });
  expect(errorCode(ambiguous)).toBe('IDENTITY_UNAVAILABLE');
  expect(ambiguous.headers['set-cookie']).toBeUndefined();
  expect(await sessionCount(fixture.b.userId)).toBe(0);
});

it.each([
  'profile-disabled',
  'tenant-disabled',
  'missing',
  'ambiguous',
] as const)(
  'logout remains available when the identity becomes %s',
  async (state) => {
    const current = await login(api, fixture.a);
    if (state === 'profile-disabled')
      await connections.owner.pool.query(
        `UPDATE public.portal_accounts SET status='disabled' WHERE id=$1`,
        [fixture.a.profileId],
      );
    if (state === 'tenant-disabled')
      await connections.owner.pool.query(
        `UPDATE public.tenants SET status='disabled' WHERE id=$1`,
        [fixture.a.tenantId],
      );
    if (state === 'missing')
      await connections.owner.pool.query(
        'DELETE FROM public.portal_accounts WHERE id=$1',
        [fixture.a.profileId],
      );
    if (state === 'ambiguous')
      await connections.owner.pool.query(
        'INSERT INTO public.admins(auth_user_id,name) VALUES($1,$2)',
        [fixture.a.userId, 'Ambiguous'],
      );
    const blocked = await getSession(current.cookie);
    expect(blocked.statusCode).toBe(403);
    expect(errorCode(blocked)).toBe(
      state === 'missing' || state === 'ambiguous'
        ? 'IDENTITY_UNAVAILABLE'
        : 'ACCOUNT_DISABLED',
    );
    const response = await api.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: requestHeaders(current.cookie),
    });
    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect(String(response.headers['set-cookie'])).toMatch(/Max-Age=0/i);
    expect(await sessionCount(fixture.a.userId)).toBe(0);
    expect((await getSession(current.cookie)).statusCode).toBe(401);
  },
);

it('emits the contract reauthentication shape for missing and confirmed expired sessions', async () => {
  const missing = await api.inject({
    method: 'GET',
    url: '/api/portal/context',
  });
  expect(missing.statusCode).toBe(401);
  expect(errorCode(missing)).toBe('UNAUTHENTICATED');
  expect(apiErrorSchema.parse(missing.json()).error).toMatchObject({
    action: 'reauthenticate',
  });
  expect(typeof apiErrorSchema.parse(missing.json()).error.requestId).toBe(
    'string',
  );
  expect(missing.headers['cache-control']).toBe('no-store');
  const current = await login(api, fixture.a);
  await connections.owner.pool.query(
    `UPDATE auth.session SET expires_at=now()-interval '1 second' WHERE user_id=$1`,
    [fixture.a.userId],
  );
  const expired = await getSession(current.cookie);
  expect(expired.statusCode).toBe(401);
  expect(errorCode(expired)).toBe('SESSION_EXPIRED');
  expect(apiErrorSchema.parse(expired.json()).error).toMatchObject({
    action: 'reauthenticate',
  });
  expect(expired.headers['cache-control']).toBe('no-store');
});

it('denies customers every admin operation and honors real admin profiles over forged role headers', async () => {
  for (const user of [fixture.a, fixture.b]) {
    const current = await login(api, user);
    for (const operation of Object.values(apiContract).filter(
      (operation) => operation.access === 'admin',
    )) {
      const response = await api.inject({
        method: operation.method,
        url: operation.path.replace('{id}', fixture.otherAdmin.profileId),
        headers: {
          ...requestHeaders(current.cookie),
          'x-role': 'admin',
          'x-auth-user-id': fixture.admin.userId,
          'x-tenant-id': fixture.b.tenantId ?? '',
        },
      });
      expect(response.statusCode, operation.operationId).toBe(403);
      expect(errorCode(response)).toBe('FORBIDDEN');
    }
  }
  const current = await login(api, fixture.admin);
  const response = await api.inject({
    method: 'GET',
    url: '/api/admin/context',
    headers: requestHeaders(current.cookie),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    identity: {
      kind: 'admin',
      profileId: fixture.admin.profileId,
      name: 'admin',
      email: fixture.admin.email,
    },
  });
});

it.each(['portal-accounts', 'admins'] as const)(
  'admin reset through %s revokes sessions, clears lock, changes credentials and preserves unrelated sessions',
  async (table) => {
    const target = table === 'portal-accounts' ? fixture.a : fixture.otherAdmin;
    const target1 = await login(api, target);
    const target2 = await login(api, target);
    const unrelated = await login(api, fixture.b);
    const current = await login(api, fixture.admin);
    for (let n = 0; n < 5; n++) await failLogin(target.email);
    const response = await api.inject({
      method: 'POST',
      url: `/api/admin/${table}/${target.profileId}/reset-password`,
      headers: requestHeaders(current.cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { temporaryPassword } = resetPasswordResponseSchema.parse(
      response.json(),
    );
    expect((await getSession(target1.cookie)).statusCode).toBe(401);
    expect((await getSession(target2.cookie)).statusCode).toBe(401);
    expect((await getSession(unrelated.cookie)).statusCode).toBe(200);
    expect(await counter(target.email)).toBeUndefined();
    expect(errorCode(await failLogin(target.email))).toBe(
      'INVALID_CREDENTIALS',
    );
    await login(api, target, temporaryPassword);
    const { rows } = await connections.owner.pool.query<{ details: unknown }>(
      `SELECT details FROM public.operation_logs WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [fixture.admin.profileId],
    );
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(temporaryPassword);
  },
);

it('admin self-reset is forbidden before changing the password, failures, or any session', async () => {
  const current = await login(api, fixture.admin);
  await login(api, fixture.admin);
  await failLogin(fixture.admin.email);
  const before = await counter(fixture.admin.email);
  const response = await api.inject({
    method: 'POST',
    url: `/api/admin/admins/${fixture.admin.profileId}/reset-password`,
    headers: requestHeaders(current.cookie),
  });
  expect(response.statusCode).toBe(403);
  expect(errorCode(response)).toBe('FORBIDDEN');
  expect(await counter(fixture.admin.email)).toEqual(before);
  expect(await sessionCount(fixture.admin.userId)).toBe(2);
  expect((await getSession(current.cookie)).statusCode).toBe(200);
  await login(api, fixture.admin);
});

it('counter cleanup removes inactive expired rows and retains current failures and locks', async () => {
  const stale = `stale-${fixture.prefix}@example.com`;
  await connections.owner.pool.query(
    `INSERT INTO auth.login_failures(email_key,window_id,failed_count,last_failed_at,locked_until) VALUES ($1,gen_random_uuid(),1,now()-interval '2 days',NULL)`,
    [stale],
  );
  await failLogin(fixture.a.email);
  for (let n = 0; n < 5; n++) await failLogin(fixture.b.email);
  await auth.cleanupCounters();
  expect(await counter(stale)).toBeUndefined();
  expect((await counter(fixture.a.email))?.failed_count).toBe(1);
  expect((await counter(fixture.b.email))?.failed_count).toBe(5);
});

describe('IP credential group', () => {
  const limited = fixtureApi(connections, {
    rateLimit: { max: 3, timeWindow: 1000 },
  });
  it('shares login and change-password limits across emails, rejects spoofed proxies before counting, leaves logout available and recovers', async () => {
    const current = await login(limited.api, fixture.a, password, '127.9.0.1');
    await limited.api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: fixture.b.email, password: 'incorrect' },
      remoteAddress: '127.9.0.1',
    });
    await limited.api.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: requestHeaders(current.cookie),
      payload: {
        currentPassword: 'incorrect',
        newPassword: 'Not-written-password',
      },
      remoteAddress: '127.9.0.1',
    });
    const before = await counter(fixture.b.email);
    const response = await limited.api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin, 'x-forwarded-for': '8.8.8.8' },
      payload: { email: fixture.b.email, password },
      remoteAddress: '127.9.0.1',
    });
    expect(response.statusCode).toBe(429);
    const body = apiErrorSchema.parse(response.json());
    expect(body.error.code).toBe('RATE_LIMITED');
    if (body.error.code !== 'RATE_LIMITED')
      throw new Error('Expected rate limit');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(String(response.headers['retry-after'])).toBe(
      String(body.error.retryAfterSeconds),
    );
    expect(await counter(fixture.b.email)).toEqual(before);
    await login(limited.api, fixture.b, password, '127.9.0.2');
    expect(
      (
        await limited.api.inject({
          method: 'POST',
          url: '/api/auth/logout',
          headers: requestHeaders(current.cookie),
          remoteAddress: '127.9.0.1',
        })
      ).statusCode,
    ).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 1050));
    await login(limited.api, fixture.b, password, '127.9.0.1');
  });
});

it('refunds a failed infrastructure attempt even when the fifth reservation would have locked and deletes the provisional session', async () => {
  for (let n = 0; n < 4; n++) await failLogin(fixture.a.email);
  const injected = fixtureApi(connections, {
    hooks: {
      afterLoginCreated: () =>
        Promise.reject(new Error('Injected auth infrastructure failure')),
    },
  });
  const response = await injected.api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: fixture.a.email, password },
  });
  expect(response.statusCode).toBe(503);
  expect(errorCode(response)).toBe('SERVICE_UNAVAILABLE');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect((await counter(fixture.a.email))?.failed_count).toBe(4);
  expect((await counter(fixture.a.email))?.locked_until).toBeNull();
  expect(await sessionCount(fixture.a.userId)).toBe(0);
  await login(api, fixture.a);
});

it('reset rollback preserves password, sessions, and failures when session revocation fails after credential update', async () => {
  const target = await login(api, fixture.a);
  const current = await login(api, fixture.admin);
  await failLogin(fixture.a.email);
  const before = await counter(fixture.a.email);
  const injected = fixtureApi(connections, {
    hooks: {
      beforeSessionDelete: () =>
        Promise.reject(new Error('Injected session deletion failure')),
    },
  });
  const response = await injected.api.inject({
    method: 'POST',
    url: `/api/admin/portal-accounts/${fixture.a.profileId}/reset-password`,
    headers: requestHeaders(current.cookie),
  });
  expect(response.statusCode).toBe(503);
  expect(errorCode(response)).toBe('SERVICE_UNAVAILABLE');
  expect(await counter(fixture.a.email)).toEqual(before);
  expect((await getSession(target.cookie)).statusCode).toBe(200);
  await login(api, fixture.a);
  const { rows } = await connections.owner.pool.query<{ count: string }>(
    'SELECT count(*) FROM public.operation_logs WHERE admin_id=$1',
    [fixture.admin.profileId],
  );
  expect(Number(rows[0]?.count)).toBe(0);
});

it.each([0, 2])(
  'reset requires exactly one credential account and rolls back when there are %i',
  async (credentialCount) => {
    const target = await login(api, fixture.a);
    const current = await login(api, fixture.admin);
    const { rows } = await connections.owner.pool.query<{ password: string }>(
      `SELECT password FROM auth.account WHERE user_id=$1`,
      [fixture.a.userId],
    );
    const oldHash = rows[0]?.password;
    if (credentialCount === 0)
      await connections.owner.pool.query(
        'DELETE FROM auth.account WHERE user_id=$1',
        [fixture.a.userId],
      );
    else
      await connections.owner.pool.query(
        `INSERT INTO auth.account(id,account_id,provider_id,user_id,password,updated_at) SELECT id||'-duplicate',account_id,provider_id,user_id,password,updated_at FROM auth.account WHERE user_id=$1`,
        [fixture.a.userId],
      );
    await failLogin(fixture.b.email);
    const response = await api.inject({
      method: 'POST',
      url: `/api/admin/portal-accounts/${fixture.a.profileId}/reset-password`,
      headers: requestHeaders(current.cookie),
    });
    expect(response.statusCode).toBe(503);
    expect((await getSession(target.cookie)).statusCode).toBe(200);
    const unchanged = await connections.owner.pool.query<{ password: string }>(
      'SELECT password FROM auth.account WHERE user_id=$1',
      [fixture.a.userId],
    );
    expect(unchanged.rows).toHaveLength(credentialCount);
    for (const row of unchanged.rows) expect(row.password).toBe(oldHash);
  },
);

it('login race guard deletes a session created by an old credential before a concurrent reset and emits no cookie', async () => {
  let temporaryPassword = '';
  const injected = fixtureApi(connections, {
    hooks: {
      afterLoginCreated: async () => {
        const result = await auth.resetPassword({
          actorAuthUserId: fixture.admin.userId,
          targetAuthUserId: fixture.a.userId,
        });
        temporaryPassword = result.temporaryPassword;
      },
    },
  });
  const response = await injected.api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: fixture.a.email, password },
  });
  expect(response.statusCode).toBe(401);
  expect(errorCode(response)).toBe('INVALID_CREDENTIALS');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(await sessionCount(fixture.a.userId)).toBe(0);
  await login(api, fixture.a, temporaryPassword);
});

it('change-password cannot overwrite a concurrent reset after validating the old credential or leave a session', async () => {
  const current = await login(api, fixture.a);
  let temporaryPassword = '';
  const injected = fixtureApi(connections, {
    hooks: {
      afterPasswordVerified: async () => {
        const result = await auth.resetPassword({
          actorAuthUserId: fixture.admin.userId,
          targetAuthUserId: fixture.a.userId,
        });
        temporaryPassword = result.temporaryPassword;
      },
    },
  });
  const response = await injected.api.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: requestHeaders(current.cookie),
    payload: {
      currentPassword: password,
      newPassword: 'Attacker-stale-password',
    },
  });
  expect(response.statusCode).toBe(401);
  expect(errorCode(response)).toBe('INVALID_CREDENTIALS');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(await sessionCount(fixture.a.userId)).toBe(0);
  await login(api, fixture.a, temporaryPassword);
  const stale = await api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email: fixture.a.email, password: 'Attacker-stale-password' },
  });
  expect(errorCode(stale)).toBe('INVALID_CREDENTIALS');
});

it('change-password infrastructure rollback refunds its shared counter without changing password or sessions', async () => {
  const current = await login(api, fixture.a);
  await failLogin(fixture.a.email);
  const injected = fixtureApi(connections, {
    hooks: {
      afterCredentialUpdated: () =>
        Promise.reject(new Error('Injected change-password failure')),
    },
  });
  const response = await injected.api.inject({
    method: 'POST',
    url: '/api/auth/change-password',
    headers: requestHeaders(current.cookie),
    payload: {
      currentPassword: password,
      newPassword: 'Never-committed-password',
    },
  });
  expect(response.statusCode).toBe(503);
  expect((await counter(fixture.a.email))?.failed_count).toBe(1);
  expect(await sessionCount(fixture.a.userId)).toBe(1);
  expect((await getSession(current.cookie)).statusCode).toBe(200);
  await login(api, fixture.a);
});

it('write routes reject untrusted origins and Better Auth internals have no mounted catch-all', async () => {
  const current = await login(api, fixture.a);
  const response = await api.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers: { cookie: current.cookie, origin: 'https://attacker.example' },
  });
  expect(response.statusCode).toBe(403);
  expect(errorCode(response)).toBe('FORBIDDEN');
  expect((await getSession(current.cookie)).statusCode).toBe(200);
  for (const path of [
    '/api/auth/sign-up/email',
    '/api/auth/sign-in/email',
    '/api/auth/admin/set-user-password',
  ]) {
    expect(
      (await api.inject({ method: 'POST', url: path, payload: {} })).statusCode,
    ).toBe(404);
  }
});

it.each(['login', 'change-password'] as const)(
  '%s refunds only its own reservation window after interleaved failures',
  async (operation) => {
    const current = await login(api, fixture.a);
    for (const interleaving of [
      'delete-recreate',
      'timeout-rollover',
      'same-window',
      'same-window-lock',
    ] as const) {
      await connections.owner.pool.query(
        'DELETE FROM auth.login_failures WHERE email_key=$1',
        [fixture.a.email],
      );
      await failLogin(fixture.a.email);
      const original = await counter(fixture.a.email);
      let interleaved: Awaited<ReturnType<typeof counter>>;
      const sameWindow =
        interleaving === 'same-window' || interleaving === 'same-window-lock';
      const interrupt = async () => {
        if (interleaving === 'delete-recreate') {
          await connections.owner.pool.query(
            'DELETE FROM auth.login_failures WHERE email_key=$1',
            [fixture.a.email],
          );
        } else if (interleaving === 'timeout-rollover') {
          await connections.owner.pool.query(
            "UPDATE auth.login_failures SET last_failed_at=clock_timestamp()-interval '16 minutes' WHERE email_key=$1",
            [fixture.a.email],
          );
        }
        const laterAttempts = sameWindow
          ? interleaving === 'same-window-lock'
            ? 3
            : 2
          : 5;
        for (let n = 1; n <= laterAttempts; n++) {
          expect(errorCode(await failLogin(fixture.a.email))).toBe(
            n === laterAttempts && interleaving !== 'same-window'
              ? 'ACCOUNT_LOCKED'
              : 'INVALID_CREDENTIALS',
          );
        }
        interleaved = await counter(fixture.a.email);
        throw new Error(
          'Injected infrastructure failure after interleaved reservations',
        );
      };
      const injected = fixtureApi(connections, {
        hooks:
          operation === 'login'
            ? { afterLoginCreated: interrupt }
            : { afterPasswordVerified: interrupt },
      });
      const response = await injected.api.inject(
        operation === 'login'
          ? {
              method: 'POST',
              url: '/api/auth/login',
              headers: { origin },
              payload: { email: fixture.a.email, password },
            }
          : {
              method: 'POST',
              url: '/api/auth/change-password',
              headers: requestHeaders(current.cookie),
              payload: {
                currentPassword: password,
                newPassword: 'Never-written-after-interleaving',
              },
            },
      );
      expect(response.statusCode).toBe(503);
      expect(errorCode(response)).toBe('SERVICE_UNAVAILABLE');
      expect(response.headers['set-cookie']).toBeUndefined();
      const after = await counter(fixture.a.email);
      if (sameWindow) {
        expect(after?.failed_count).toBe(
          interleaving === 'same-window-lock' ? 4 : 3,
        );
        expect(after?.locked_until).toBeNull();
        expect(after?.window_id).toBe(original?.window_id);
      } else {
        expect(after?.failed_count).toBe(5);
        expect(after?.locked_until).toBeInstanceOf(Date);
        expect(after?.window_id).not.toBe(original?.window_id);
        expect(after).toEqual(interleaved);
      }
      expect(await sessionCount(fixture.a.userId)).toBe(1);
      expect((await getSession(current.cookie)).statusCode).toBe(200);
    }
  },
);

it('actual auth columns match the installed Better Auth tables with configured field names', async () => {
  const tables = getAuthTables(auth.auth.options);
  expect(Object.keys(tables).sort()).toEqual([
    'account',
    'session',
    'user',
    'verification',
  ]);
  const result = await connections.owner.pool.query<{
    table_name: string;
    column_name: string;
  }>(
    "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='auth'",
  );
  for (const table of Object.values(tables)) {
    const expected = [
      'id',
      ...Object.entries(table.fields).map(
        ([key, field]) => field.fieldName ?? key,
      ),
    ].sort();
    const actual = result.rows
      .filter((row) => row.table_name === table.modelName)
      .map((row) => row.column_name)
      .sort();
    expect(actual, table.modelName).toEqual(expected);
  }
});
