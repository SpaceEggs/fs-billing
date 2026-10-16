import { z } from 'zod';
import { identitySchema } from '@fs-billing/shared';
import { sql, withAdmin, type Db } from '@fs-billing/db';
import type { AuthSession } from './auth/gateway.js';
import { ApiFailure } from './errors.js';
import {
  principalSchema,
  type Principal,
  type ResolvedIdentity,
} from './types.js';

const rowSchema = z.object({
  kind: z.enum(['none', 'ambiguous', 'admin', 'customer']),
  profile_id: z.uuid().nullable(),
  tenant_id: z.uuid().nullable(),
  profile_name: z.string().nullable(),
  profile_status: z.string().nullable(),
  tenant_code: z.string().nullable(),
  tenant_name: z.string().nullable(),
  tenant_currency: z.enum(['CNY', 'USD']).nullable(),
  tenant_status: z.string().nullable(),
});
export async function resolvePrincipal(
  db: Db,
  session: AuthSession,
): Promise<ResolvedIdentity> {
  const result = await db.execute(
    sql`select * from public.resolve_auth_identity(${session.authUserId})`,
  );
  if (result.rows.length !== 1) throw new ApiFailure('IDENTITY_UNAVAILABLE');
  const row = rowSchema.parse(result.rows[0]);
  if (row.kind === 'none' || row.kind === 'ambiguous')
    throw new ApiFailure('IDENTITY_UNAVAILABLE');
  if (
    row.profile_status !== 'active' ||
    (row.kind === 'customer' && row.tenant_status !== 'active')
  )
    throw new ApiFailure('ACCOUNT_DISABLED');
  const principal = principalSchema.parse({
    kind: row.kind,
    authUserId: session.authUserId,
    profileId: row.profile_id,
    tenantId: row.tenant_id,
  });
  const identity = identitySchema.parse(
    row.kind === 'admin'
      ? {
          kind: 'admin',
          profileId: row.profile_id,
          name: row.profile_name,
          email: session.email,
        }
      : {
          kind: 'customer',
          profileId: row.profile_id,
          email: session.email,
          tenant: {
            id: row.tenant_id,
            code: row.tenant_code,
            name: row.tenant_name,
            currency: row.tenant_currency,
          },
        },
  );
  if (principal.kind === 'admin' && identity.kind === 'admin')
    return { kind: 'admin', principal, identity };
  if (principal.kind === 'customer' && identity.kind === 'customer')
    return { kind: 'customer', principal, identity };
  throw new ApiFailure('IDENTITY_UNAVAILABLE');
}

export async function recordLogin(db: Db, principal: Principal): Promise<void> {
  await withAdmin(db, async (tx) => {
    const result = await tx.execute(
      principal.kind === 'admin'
        ? sql`update admins set last_login_at = GREATEST(last_login_at, statement_timestamp())
              where id = ${principal.profileId} and auth_user_id = ${principal.authUserId}
              returning id`
        : sql`update portal_accounts set last_login_at = GREATEST(last_login_at, statement_timestamp())
              where id = ${principal.profileId} and auth_user_id = ${principal.authUserId}
                and tenant_id = ${principal.tenantId}
              returning id`,
    );
    if (result.rows.length !== 1) throw new ApiFailure('IDENTITY_UNAVAILABLE');
  });
}
