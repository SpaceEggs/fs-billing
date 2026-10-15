import { operateBalance, listTenantLedger, type Db } from '@fs-billing/db';
import {
  adminAmountRequestSchemas,
  type AdminAmountRequestSchemas,
  adminLedgerQuerySchema,
  adminTenantParamsSchema,
} from '@fs-billing/shared';
import type { RouteHandlers } from '../register.js';
import { adminActor } from './tenants.js';

export function balanceHandlers(
  db: Db,
  amountRequests: AdminAmountRequestSchemas = adminAmountRequestSchemas,
): Pick<RouteHandlers, 'adminBalanceOperation' | 'adminTenantLedger'> {
  return {
    adminBalanceOperation: (context, request) =>
      operateBalance({
        db,
        actor: adminActor(context),
        ...adminTenantParamsSchema.parse(request.params),
        amountRequests,
        request: amountRequests.balance.parse(request.body),
      }),
    adminTenantLedger: (_context, request) =>
      listTenantLedger({
        db,
        ...adminTenantParamsSchema.parse(request.params),
        query: adminLedgerQuerySchema.parse(request.query),
      }),
  };
}
