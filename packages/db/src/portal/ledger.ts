import { sql } from 'drizzle-orm';
import {
  PORTAL_LEDGER_PAGE_SIZE,
  portalLedgerQuerySchema,
  portalLedgerResponseSchema,
  type PortalLedgerQuery,
  type PortalLedgerResponse,
} from '@fs-billing/shared';
import { withTenant, type Db } from '../client.js';
import { NotFoundError } from '../errors.js';
import { mergedLedgerSql } from '../ledger-merge.js';

export function listPortalLedger({
  db,
  tenantId,
  query,
}: {
  db: Db;
  tenantId: string;
  query: PortalLedgerQuery;
}): Promise<PortalLedgerResponse> {
  const input = portalLedgerQuerySchema.parse(query);
  return withTenant(db, tenantId, async (tx) => {
    await tx.execute(sql`set local jit = off`);
    const { rows } = await tx.execute<{ ledger: unknown }>(
      mergedLedgerSql({
        tenantId,
        query: input,
        pageSize: PORTAL_LEDGER_PAGE_SIZE,
        audience: 'portal',
      }),
    );
    if (!rows[0]) throw new NotFoundError('租户不存在');
    return portalLedgerResponseSchema.parse(rows[0].ledger);
  });
}
