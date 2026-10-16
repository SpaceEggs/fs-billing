import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  adminAccountsResponseSchema,
  adminPortalAccountsResponseSchema,
} from '@fs-billing/shared';
import {
  apiConnections,
  cookieFrom,
  createFixture,
  fixtureApi,
  login,
  origin,
  password,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let observerCookie: string;
beforeAll(() => api.ready());
beforeEach(async () => {
  fixture = await createFixture(connections);
  observerCookie = (await login(api, fixture.otherAdmin)).cookie;
});

const profiles = [
  { kind: 'admin', table: 'admins' },
  { kind: 'portal', table: 'portal_accounts' },
] as const;
type ProfileKind = (typeof profiles)[number]['kind'];
const userFor = (kind: ProfileKind) =>
  kind === 'admin' ? fixture.admin : fixture.a;

async function lastLoginAt(kind: ProfileKind) {
  const user = userFor(kind);
  const response = await api.inject({
    method: 'GET',
    url:
      kind === 'admin'
        ? `/api/admin/admins?search=${encodeURIComponent(user.email)}`
        : `/api/admin/tenants/${user.tenantId}/portal-accounts`,
    headers: requestHeaders(observerCookie),
  });
  expect(response.statusCode).toBe(200);
  const body =
    kind === 'admin'
      ? adminAccountsResponseSchema.parse(response.json())
      : adminPortalAccountsResponseSchema.parse(response.json());
  const profile = body.items.find((item) => item.id === user.profileId);
  expect(profile).toBeDefined();
  return profile!.lastLoginAt;
}

async function databaseTime() {
  const result = await connections.owner.pool.query<{ time: Date }>(
    'SELECT clock_timestamp() AS time',
  );
  return result.rows[0]!.time.getTime();
}

it.each(profiles)(
  '$kind credential logins set and advance the timestamp exposed to admins',
  async ({ kind }) => {
    expect(await lastLoginAt(kind)).toBeNull();
    const before = await databaseTime();
    await login(api, userFor(kind));
    const first = await lastLoginAt(kind);
    expect(first).not.toBeNull();
    expect(Date.parse(first!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(first!)).toBeLessThanOrEqual(await databaseTime());
    await login(api, userFor(kind));
    const second = await lastLoginAt(kind);
    expect(Date.parse(second!)).toBeGreaterThan(Date.parse(first!));
    expect(await lastLoginAt(kind === 'admin' ? 'portal' : 'admin')).toBeNull();
  },
);

it.each(profiles)(
  '$kind credential login preserves a later existing timestamp',
  async ({ kind, table }) => {
    const user = userFor(kind);
    await connections.owner.pool.query(
      `UPDATE public.${table}
       SET last_login_at = statement_timestamp() + interval '1 day'
       WHERE id = $1`,
      [user.profileId],
    );
    const recorded = await lastLoginAt(kind);
    expect(recorded).not.toBeNull();
    expect(Date.parse(recorded!)).toBeGreaterThan(await databaseTime());

    await login(api, user);

    expect(await lastLoginAt(kind)).toBe(recorded);
  },
);

it.each(profiles)(
  '$kind failed logins preserve the previous timestamp',
  async ({ kind, table }) => {
    const user = userFor(kind);
    const original = '2020-01-02T03:04:05.000Z';
    await connections.owner.pool.query(
      `UPDATE public.${table} SET last_login_at=$1 WHERE id=$2`,
      [original, user.profileId],
    );
    for (const state of ['bad-password', 'expired', 'disabled', 'locked']) {
      if (state === 'expired')
        await connections.owner.pool.query(
          "UPDATE auth.account SET temporary_password_issued_at=now()-interval '73 hours' WHERE user_id=$1",
          [user.userId],
        );
      if (state === 'disabled') {
        await connections.owner.pool.query(
          'UPDATE auth.account SET temporary_password_issued_at=NULL WHERE user_id=$1',
          [user.userId],
        );
        await connections.owner.pool.query(
          `UPDATE public.${table} SET status='disabled' WHERE id=$1`,
          [user.profileId],
        );
      }
      if (state === 'locked')
        await connections.owner.pool.query(
          `INSERT INTO auth.login_failures(email_key,window_id,failed_count,last_failed_at,locked_until)
           VALUES($1,gen_random_uuid(),5,now(),now()+interval '15 minutes')
           ON CONFLICT(email_key) DO UPDATE SET failed_count=5,last_failed_at=now(),locked_until=now()+interval '15 minutes'`,
          [user.email],
        );
      const response = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: {
          email: user.email,
          password: state === 'bad-password' ? 'incorrect' : password,
        },
      });
      expect(response.statusCode).toBe(
        state === 'locked' ? 429 : state === 'disabled' ? 403 : 401,
      );
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(await lastLoginAt(kind)).toBe(original);
    }
  },
);

it.each(profiles)(
  '$kind temporary-password login counts but password change and session reads do not',
  async ({ kind }) => {
    const user = userFor(kind);
    await connections.owner.pool.query(
      'UPDATE auth.account SET temporary_password_issued_at=now() WHERE user_id=$1',
      [user.userId],
    );
    const session = await login(api, user);
    expect(session.body.passwordChangeRequired).toBe(true);
    const recorded = await lastLoginAt(kind);
    expect(recorded).not.toBeNull();
    const changed = await api.inject({
      method: 'POST',
      url: '/api/auth/change-password',
      headers: requestHeaders(session.cookie),
      payload: {
        currentPassword: password,
        newPassword: 'Changed-password-88',
      },
    });
    expect(changed.statusCode).toBe(200);
    expect(await lastLoginAt(kind)).toBe(recorded);
    const read = await api.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: requestHeaders(cookieFrom(changed)),
    });
    expect(read.statusCode).toBe(200);
    expect(await lastLoginAt(kind)).toBe(recorded);
  },
);

it.each(profiles)(
  '$kind rate-limited credential login preserves the previous timestamp',
  async ({ kind }) => {
    const limited = fixtureApi(connections, {
      rateLimit: { max: 1, timeWindow: 60_000 },
    });
    const user = userFor(kind);
    await login(limited.api, user);
    const recorded = await lastLoginAt(kind);
    const denied = await limited.api.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin },
      payload: { email: user.email, password },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json()).toMatchObject({ error: { code: 'RATE_LIMITED' } });
    expect(await lastLoginAt(kind)).toBe(recorded);
  },
);

it.each(profiles)(
  '$kind timestamp is generated by the database statement',
  async ({ kind, table }) => {
    await connections.owner.pool.query(`
      CREATE FUNCTION public.assert_login_database_time() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.last_login_at IS DISTINCT FROM statement_timestamp()
           AND NEW.last_login_at IS DISTINCT FROM now() THEN
          RAISE EXCEPTION 'Login timestamp must use database time';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER assert_login_database_time BEFORE UPDATE OF last_login_at
      ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.assert_login_database_time();
    `);
    try {
      await login(api, userFor(kind));
      expect(await lastLoginAt(kind)).not.toBeNull();
    } finally {
      await connections.owner.pool.query(`
        DROP TRIGGER assert_login_database_time ON public.${table};
        DROP FUNCTION public.assert_login_database_time();
      `);
    }
  },
);

it.each([
  { code: '23514', status: 500, error: 'INTERNAL_ERROR' },
  { code: '08006', status: 503, error: 'SERVICE_UNAVAILABLE' },
])(
  'timestamp write failure $code rejects login and discards its session',
  async ({ code, status, error }) => {
    const transaction = vi
      .spyOn(connections.app.db, 'transaction')
      .mockRejectedValue(
        Object.assign(new Error('Injected timestamp write failure'), { code }),
      );
    try {
      const response = await api.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { origin },
        payload: { email: fixture.a.email, password },
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({ error: { code: error } });
      expect(response.headers['set-cookie']).toBeUndefined();
    } finally {
      transaction.mockRestore();
    }
    expect(await lastLoginAt('portal')).toBeNull();
    const sessions = await connections.owner.pool.query(
      'SELECT id FROM auth.session WHERE user_id=$1',
      [fixture.a.userId],
    );
    expect(sessions.rows).toEqual([]);
  },
);
