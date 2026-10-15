import { betterAuth } from 'better-auth';
import { Kysely, PostgresDialect } from 'kysely';
import type { Pool } from 'pg';

export function assertAuthOptions(options: {
  session?: { cookieCache?: { enabled?: boolean } };
  secondaryStorage?: unknown;
}) {
  if (
    options.session?.cookieCache?.enabled !== false ||
    options.secondaryStorage !== undefined
  ) {
    throw new Error(
      'Auth requires cookieCache.enabled=false and secondaryStorage unset',
    );
  }
}

export function createBetterAuth(input: {
  pool: Pool;
  secret: string;
  baseURL: string;
  secureCookies: boolean;
  trustedOrigins: string[];
}) {
  const options = {
    database: {
      db: new Kysely({ dialect: new PostgresDialect({ pool: input.pool }) }),
      type: 'postgres' as const,
      schemaName: 'auth',
      transaction: true,
    },
    secret: input.secret,
    baseURL: input.baseURL,
    trustedOrigins: input.trustedOrigins,
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 8,
      maxPasswordLength: 128,
    },
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: false },
    advanced: { useSecureCookies: input.secureCookies },
    user: {
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      additionalFields: {
        temporaryPasswordIssuedAt: {
          type: 'date' as const,
          fieldName: 'temporary_password_issued_at',
          required: false,
          input: false,
          returned: false,
        },
      },
      fields: {
        accountId: 'account_id',
        providerId: 'provider_id',
        userId: 'user_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
  };
  const configured = {
    ...options,
    session: {
      ...options.session,
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
      },
    },
  };
  return betterAuth(configured);
}
export type BillingAuth = ReturnType<typeof createBetterAuth>;

export async function assertEffectiveAuthOptions(
  auth: Pick<BillingAuth, '$context'>,
) {
  assertAuthOptions((await auth.$context).options);
}
