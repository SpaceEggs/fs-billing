import { eq, schema, type Tx } from '@fs-billing/db';
import type { CustomerPrincipal } from '../types.js';
import { ApiFailure } from '../errors.js';

export async function readPortalBalance(tx: Tx, principal: CustomerPrincipal) {
  const [row] = await tx
    .select({ amount: schema.tenantBalances.balance })
    .from(schema.tenantBalances)
    .where(eq(schema.tenantBalances.tenantId, principal.tenantId));
  if (!row) throw new ApiFailure('NOT_FOUND');
  return row.amount;
}
