import {
  adminAccountsQuerySchema,
  adminAccountCreateRequestSchema,
  adminPortalAccountCreateRequestSchema,
  adminIdParamsSchema,
  adminTenantParamsSchema,
} from '@fs-billing/shared';
import type { AdminAccountService } from '../../auth/admin-accounts.js';
import type { RequestContext } from '../../types.js';
import { ApiFailure } from '../../errors.js';
import type { RouteHandlers } from '../register.js';

function principal(context: RequestContext) {
  if (context.kind !== 'admin') throw new ApiFailure('FORBIDDEN');
  return context.principal;
}
export function accountHandlers(
  service: AdminAccountService | undefined,
): Pick<
  RouteHandlers,
  | 'adminAccounts'
  | 'adminAccountCreate'
  | 'adminAccountDisable'
  | 'adminAccountEnable'
  | 'adminPortalAccounts'
  | 'adminPortalAccountCreate'
  | 'adminPortalAccountDisable'
  | 'adminPortalAccountEnable'
> {
  function accounts(context: RequestContext) {
    principal(context);
    if (!service) throw new ApiFailure('INTERNAL_ERROR');
    return service;
  }
  return {
    adminAccounts: async (context, request) => {
      principal(context);
      return accounts(context).listAdmins(
        adminAccountsQuerySchema.parse(request.query),
      );
    },
    adminAccountCreate: (context, request) =>
      accounts(context).createAdmin(
        principal(context),
        adminAccountCreateRequestSchema.parse(request.body),
      ),
    adminAccountDisable: (context, request) =>
      accounts(context).setStatus(principal(context), {
        kind: 'admin',
        id: adminIdParamsSchema.parse(request.params).id,
        status: 'disabled',
      }),
    adminAccountEnable: (context, request) =>
      accounts(context).setStatus(principal(context), {
        kind: 'admin',
        id: adminIdParamsSchema.parse(request.params).id,
        status: 'active',
      }),
    adminPortalAccounts: async (context, request) => {
      principal(context);
      return accounts(context).listPortal(
        adminTenantParamsSchema.parse(request.params).tenantId,
      );
    },
    adminPortalAccountCreate: (context, request) =>
      accounts(context).createPortal(
        principal(context),
        adminTenantParamsSchema.parse(request.params).tenantId,
        adminPortalAccountCreateRequestSchema.parse(request.body),
      ),
    adminPortalAccountDisable: (context, request) =>
      accounts(context).setStatus(principal(context), {
        kind: 'portal',
        id: adminIdParamsSchema.parse(request.params).id,
        status: 'disabled',
      }),
    adminPortalAccountEnable: (context, request) =>
      accounts(context).setStatus(principal(context), {
        kind: 'portal',
        id: adminIdParamsSchema.parse(request.params).id,
        status: 'active',
      }),
  };
}
