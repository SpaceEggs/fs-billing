import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import type {
  AuthGateway,
  AuthHooks,
  AuthLogger,
  AuthSession,
  IssuedSession,
} from './types.js';
import { GatewayError } from './types.js';
import { createBetterAuth } from './better-auth.js';
export { GatewayError } from './types.js';
export type {
  AuthGateway,
  AuthSession,
  IssuedSession,
  AuthHooks,
} from './types.js';
export { assertAuthOptions, createBetterAuth } from './better-auth.js';

export const normalizeEmail = (email: string) => email.toLowerCase();
const signInSchema = z.object({
  token: z.string(),
  user: z.object({ id: z.string(), email: z.string() }),
});
const failureSchema = z.object({ code: z.string() });

export interface GatewayOptions {
  pool: Pool;
  secret: string;
  baseURL: string;
  secureCookies: boolean;
  trustedOrigins: string[];
  logger: AuthLogger;
  hooks?: AuthHooks;
}

export function createAuthGateway(
  options: GatewayOptions,
): AuthGateway & { auth: ReturnType<typeof createBetterAuth> } {
  const { pool, logger, hooks = {} } = options;
  const auth = createBetterAuth(options);
  const cookieName = `${options.secureCookies ? '__Secure-' : ''}better-auth.session_token`;
  const sign = (token: string) =>
    createHmac('sha256', options.secret).update(token).digest('base64');
  const cookie = (token: string, expiresAt: Date) =>
    `${cookieName}=${encodeURIComponent(`${token}.${sign(token)}`)}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${options.secureCookies ? '; Secure' : ''}`;
  const clearCookie = () =>
    `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${options.secureCookies ? '; Secure' : ''}`;
  function readToken(headers: Headers) {
    const item = headers
      .get('cookie')
      ?.split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${cookieName}=`));
    if (!item) return null;
    let value: string;
    try {
      value = decodeURIComponent(item.slice(cookieName.length + 1));
    } catch {
      return null;
    }
    const split = value.lastIndexOf('.');
    if (split < 0) return null;
    const token = value.slice(0, split);
    const supplied = Buffer.from(value.slice(split + 1));
    const expected = Buffer.from(sign(token));
    return supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
      ? token
      : null;
  }
  async function timestamp() {
    const result = await pool.query<{ now: string }>(
      'SELECT clock_timestamp()::text AS now',
    );
    const row = result.rows[0];
    if (!row) throw new Error('Database clock unavailable');
    return row.now;
  }
  async function reserve(email: string) {
    const result = await pool.query<{
      failed_count: number;
      locked_until: Date | null;
      window_id: string;
      retry: number;
    }>(
      `
      INSERT INTO auth.login_failures(email_key, window_id, failed_count, last_failed_at, locked_until)
      VALUES ($1, gen_random_uuid(), 1, clock_timestamp(), NULL)
      ON CONFLICT(email_key) DO UPDATE
      SET (window_id, failed_count, last_failed_at, locked_until) = (
        WITH reservation_clock AS MATERIALIZED (SELECT clock_timestamp() AS now)
        SELECT
          CASE WHEN auth.login_failures.last_failed_at <= now - interval '15 minutes' THEN gen_random_uuid() ELSE auth.login_failures.window_id END,
          CASE WHEN auth.login_failures.last_failed_at <= now - interval '15 minutes' THEN 1 ELSE auth.login_failures.failed_count + 1 END,
          now,
          CASE WHEN auth.login_failures.last_failed_at <= now - interval '15 minutes' THEN NULL WHEN auth.login_failures.failed_count + 1 >= 5 THEN now + interval '15 minutes' ELSE NULL END
        FROM reservation_clock
      )
      WHERE auth.login_failures.locked_until IS NULL OR auth.login_failures.locked_until <= clock_timestamp()
      RETURNING failed_count, locked_until, window_id, greatest(1, ceil(extract(epoch from locked_until - clock_timestamp())))::integer AS retry`,
      [email],
    );
    const attempt = result.rows[0];
    if (!attempt) {
      const locked = await pool.query<{ retry: number }>(
        `SELECT greatest(1, ceil(extract(epoch from locked_until - clock_timestamp())))::integer AS retry FROM auth.login_failures WHERE email_key=$1`,
        [email],
      );
      throw new GatewayError('ACCOUNT_LOCKED', locked.rows[0]?.retry ?? 1);
    }
    if (attempt.failed_count === 5)
      logger.info(
        {
          event: 'auth.account_locked',
          emailKey: email,
          lockedUntil: attempt.locked_until,
        },
        'Account lock entered',
      );
    return attempt;
  }
  async function refund(email: string, windowId: string) {
    await pool.query(
      `UPDATE auth.login_failures SET failed_count=greatest(0,failed_count-1), locked_until=CASE WHEN failed_count <= 5 THEN NULL ELSE locked_until END WHERE email_key=$1 AND window_id=$2::uuid`,
      [email, windowId],
    );
  }
  async function clear(email: string, client: Pool | PoolClient = pool) {
    await client.query('DELETE FROM auth.login_failures WHERE email_key=$1', [
      email,
    ]);
  }
  async function discardSession(token: string) {
    await pool.query('DELETE FROM auth.session WHERE token=$1', [token]);
  }
  async function loadSession(token: string): Promise<AuthSession> {
    const result = await pool.query<{
      user_id: string;
      email: string;
      token: string;
      expires_at: Date;
      expired: boolean;
    }>(
      `SELECT s.user_id,u.email,s.token,s.expires_at,s.expires_at <= clock_timestamp() AS expired FROM auth.session s JOIN auth."user" u ON u.id=s.user_id WHERE s.token=$1`,
      [token],
    );
    const row = result.rows[0];
    if (!row) throw new GatewayError('UNAUTHENTICATED');
    if (row.expired) throw new GatewayError('SESSION_EXPIRED');
    return {
      authUserId: row.user_id,
      email: row.email,
      token: row.token,
      expiresAt: row.expires_at,
    };
  }
  async function guardedSession(token: string, userId: string, t0: string) {
    const changed = await pool.query(
      `SELECT 1 FROM auth.account WHERE user_id=$1 AND provider_id='credential' AND updated_at > $2::timestamptz`,
      [userId, t0],
    );
    if (changed.rowCount !== 0) {
      await discardSession(token);
      throw new GatewayError('INVALID_CREDENTIALS');
    }
    return loadSession(token);
  }
  return {
    auth,
    discardSession,
    async cleanupCounters() {
      const result = await pool.query(
        `DELETE FROM auth.login_failures WHERE last_failed_at < clock_timestamp() - interval '15 minutes' AND (locked_until IS NULL OR locked_until <= clock_timestamp())`,
      );
      return result.rowCount ?? 0;
    },
    async session(headers) {
      const token = readToken(headers);
      if (!token) throw new GatewayError('UNAUTHENTICATED');
      return loadSession(token);
    },
    async logout(headers) {
      const token = readToken(headers);
      if (!token) throw new GatewayError('UNAUTHENTICATED');
      await loadSession(token);
      await discardSession(token);
      return [clearCookie()];
    },
    async login(body, headers) {
      const email = normalizeEmail(body.email);
      const t0 = await timestamp();
      const attempt = await reserve(email);
      let token: string | undefined;
      try {
        const response = await auth.api.signInEmail({
          body,
          headers,
          asResponse: true,
        });
        const payload: unknown = await response.json();
        if (!response.ok) {
          const failure = failureSchema.safeParse(payload);
          if (
            failure.success &&
            ((response.status === 401 &&
              failure.data.code === 'INVALID_EMAIL_OR_PASSWORD') ||
              (response.status === 400 &&
                failure.data.code === 'PASSWORD_TOO_LONG'))
          ) {
            throw new GatewayError(
              attempt.failed_count >= 5
                ? 'ACCOUNT_LOCKED'
                : 'INVALID_CREDENTIALS',
              attempt.failed_count >= 5 ? attempt.retry : undefined,
            );
          }
          if (response.status === 403) throw new GatewayError('FORBIDDEN');
          throw new Error('Better Auth sign-in infrastructure failure');
        }
        const signed = signInSchema.parse(payload);
        token = signed.token;
        await hooks.afterLoginCreated?.();
        const session = await guardedSession(token, signed.user.id, t0);
        await clear(email);
        const setCookie = response.headers.getSetCookie();
        return { ...session, setCookie };
      } catch (error) {
        try {
          if (token) await discardSession(token);
        } finally {
          if (
            token ||
            !(error instanceof GatewayError) ||
            (error.code !== 'INVALID_CREDENTIALS' &&
              error.code !== 'ACCOUNT_LOCKED')
          ) {
            await refund(email, attempt.window_id);
          }
        }
        throw error;
      }
    },
    async revokeOtherSessions(session) {
      await pool.query(
        'DELETE FROM auth.session WHERE user_id=$1 AND token<>$2',
        [session.authUserId, session.token],
      );
    },
    async changePassword(session, body): Promise<IssuedSession> {
      const email = normalizeEmail(session.email);
      const t0 = await timestamp();
      const attempt = await reserve(email);
      try {
        const result = await pool.query<{ password: string; version: string }>(
          `SELECT password,updated_at::text AS version FROM auth.account WHERE user_id=$1 AND provider_id='credential'`,
          [session.authUserId],
        );
        const credential = result.rows[0];
        const context = await auth.$context;
        if (
          !credential ||
          !(await context.password.verify({
            hash: credential.password,
            password: body.currentPassword,
          }))
        ) {
          throw new GatewayError(
            attempt.failed_count >= 5
              ? 'ACCOUNT_LOCKED'
              : 'INVALID_CREDENTIALS',
            attempt.failed_count >= 5 ? attempt.retry : undefined,
          );
        }
        await hooks.afterPasswordVerified?.();
        const hash = await context.password.hash(body.newPassword);
        const token = randomBytes(32).toString('base64url');
        const client = await pool.connect();
        let expiresAt: Date;
        try {
          await client.query('BEGIN');
          const updated = await client.query(
            `UPDATE auth.account SET password=$1,updated_at=clock_timestamp() WHERE user_id=$2 AND provider_id='credential' AND updated_at=$3::timestamptz AND updated_at <= $4::timestamptz RETURNING updated_at`,
            [hash, session.authUserId, credential.version, t0],
          );
          if (updated.rowCount !== 1)
            throw new GatewayError('INVALID_CREDENTIALS');
          await hooks.afterCredentialUpdated?.();
          await hooks.beforeSessionDelete?.();
          await client.query('DELETE FROM auth.session WHERE user_id=$1', [
            session.authUserId,
          ]);
          const created = await client.query<{ expires_at: Date }>(
            `INSERT INTO auth.session(id,token,user_id,expires_at,created_at,updated_at) VALUES($1,$2,$3,clock_timestamp()+interval '7 days',clock_timestamp(),clock_timestamp()) RETURNING expires_at`,
            [randomUUID(), token, session.authUserId],
          );
          const row = created.rows[0];
          if (!row) throw new Error('Session creation failed');
          expiresAt = row.expires_at;
          await clear(email, client);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
        await loadSession(token);
        return {
          ...session,
          token,
          expiresAt,
          setCookie: [cookie(token, expiresAt)],
        };
      } catch (error) {
        if (
          !(error instanceof GatewayError) ||
          (error.code !== 'INVALID_CREDENTIALS' &&
            error.code !== 'ACCOUNT_LOCKED')
        )
          await refund(email, attempt.window_id);
        throw error;
      }
    },
    async resetPassword({ actorAuthUserId, targetAuthUserId }) {
      if (actorAuthUserId === targetAuthUserId)
        throw new GatewayError('FORBIDDEN');
      const temporaryPassword = randomBytes(24).toString('base64url');
      const hash = await (await auth.$context).password.hash(temporaryPassword);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const updated = await client.query(
          `UPDATE auth.account SET password=$1,updated_at=clock_timestamp() WHERE user_id=$2 AND provider_id='credential'`,
          [hash, targetAuthUserId],
        );
        if (updated.rowCount !== 1)
          throw new Error('Expected exactly one credential account');
        await hooks.afterCredentialUpdated?.();
        await hooks.beforeSessionDelete?.();
        await client.query('DELETE FROM auth.session WHERE user_id=$1', [
          targetAuthUserId,
        ]);
        await client.query(
          `DELETE FROM auth.login_failures WHERE email_key=(SELECT lower(email) FROM auth."user" WHERE id=$1)`,
          [targetAuthUserId],
        );
        await client.query('COMMIT');
        return { temporaryPassword };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
