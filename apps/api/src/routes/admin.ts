import { eq, withAdmin, schema, type Db } from '@fs-billing/db';
import type { AuthGateway } from '../auth/gateway.js';
import type { AdminPrincipal } from '../types.js';
import { ApiFailure } from '../errors.js';

export async function resetProfilePassword(
  deps: {
    businessDb: Db;
    auth: AuthGateway;
    auditFailure: (error: unknown) => void;
  },
  principal: AdminPrincipal,
  profile: 'admin' | 'customer',
  id: string,
) {
  if (profile === 'admin' && id === principal.profileId)
    throw new ApiFailure('FORBIDDEN');
  const target = await withAdmin(deps.businessDb, async (tx) => {
    const table = profile === 'admin' ? schema.admins : schema.portalAccounts;
    const [row] = await tx
      .select({ authUserId: table.authUserId })
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    if (!row) throw new ApiFailure('NOT_FOUND');
    return row;
  });
  const result = await deps.auth.resetPassword({
    actorAuthUserId: principal.authUserId,
    targetAuthUserId: target.authUserId,
  });
  try {
    await withAdmin(deps.businessDb, (tx) =>
      tx.insert(schema.operationLogs).values({
        adminId: principal.profileId,
        action: 'reset_password',
        target: `${profile}:${id}`,
        details: {},
      }),
    );
  } catch (error) {
    deps.auditFailure(error);
  }
  return result;
}
