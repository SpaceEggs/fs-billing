import {
  listAdminStatements,
  listAdminTenantStatements,
  listPortalStatements,
  readAdminTenantStatement,
  readPortalStatement,
  regenerateAdminTenantStatement,
  type Db,
} from '@fs-billing/db';
import {
  adminStatementApiContract,
  adminStatementsQuerySchema,
  adminTenantParamsSchema,
  statementMonthParamsSchema,
} from '@fs-billing/shared';
import type { RequestContext } from '../types.js';
import { ApiFailure } from '../errors.js';
import type { RouteHandlers } from './register.js';
import { adminActor } from './admin/tenants.js';

const tenantMonthParams =
  adminStatementApiContract.adminTenantStatement.request.params;
const regenerateRequest =
  adminStatementApiContract.adminTenantStatementRegenerate.request.body;

function customerTenant(context: RequestContext) {
  if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
  return context.principal.tenantId;
}

export function statementHandlers(
  db: Db,
): Pick<
  RouteHandlers,
  | 'portalStatements'
  | 'portalStatement'
  | 'adminStatements'
  | 'adminTenantStatements'
  | 'adminTenantStatement'
  | 'adminTenantStatementRegenerate'
> {
  return {
    portalStatements: (context) =>
      listPortalStatements({ db, tenantId: customerTenant(context) }),
    portalStatement: (context, request) =>
      readPortalStatement({
        db,
        tenantId: customerTenant(context),
        month: statementMonthParamsSchema.parse(request.params).month,
      }),
    adminStatements: (_context, request) =>
      listAdminStatements({
        db,
        query: adminStatementsQuerySchema.parse(request.query),
      }),
    adminTenantStatements: (_context, request) =>
      listAdminTenantStatements({
        db,
        ...adminTenantParamsSchema.parse(request.params),
      }),
    adminTenantStatement: (_context, request) =>
      readAdminTenantStatement({
        db,
        ...tenantMonthParams.parse(request.params),
      }),
    adminTenantStatementRegenerate: (context, request) =>
      regenerateAdminTenantStatement({
        db,
        actor: adminActor(context),
        ...tenantMonthParams.parse(request.params),
        request: regenerateRequest.parse(request.body),
      }),
  };
}
