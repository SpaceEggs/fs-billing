import {
  createTenant,
  getTenantOverview,
  listTenants,
  getTenant,
  editTenant,
  disableTenant,
  enableTenant,
  updateTenantSettings,
  type Db,
} from '@fs-billing/db';
import {
  adminTenantParamsSchema,
  adminAmountRequestSchemas,
  type AdminAmountRequestSchemas,
  adminTenantEditRequestSchema,
  adminTenantsQuerySchema,
} from '@fs-billing/shared';
import type { RequestContext } from '../../types.js';
import { ApiFailure } from '../../errors.js';
import type { RouteHandlers } from '../register.js';

export function adminActor(context: RequestContext) {
  if (context.kind !== 'admin') throw new ApiFailure('FORBIDDEN');
  return { id: context.principal.profileId, name: context.identity.name };
}
export function tenantHandlers(
  db: Db,
  amountRequests: AdminAmountRequestSchemas = adminAmountRequestSchemas,
): Pick<
  RouteHandlers,
  | 'adminTenants'
  | 'adminTenantCreate'
  | 'adminTenantDetail'
  | 'adminTenantOverview'
  | 'adminTenantEdit'
  | 'adminTenantDisable'
  | 'adminTenantEnable'
  | 'adminTenantSettings'
> {
  return {
    adminTenants: (_context, request) =>
      listTenants({ db, query: adminTenantsQuerySchema.parse(request.query) }),
    adminTenantCreate: (context, request) => {
      const actor = adminActor(context);
      if (context.kind !== 'admin') throw new ApiFailure('FORBIDDEN');
      return createTenant({
        db,
        actor,
        creatorEmail: context.identity.email,
        amountRequests,
        request: amountRequests.tenantCreate.parse(request.body),
      });
    },
    adminTenantDetail: (_context, request) =>
      getTenant({ db, ...adminTenantParamsSchema.parse(request.params) }),
    adminTenantOverview: (_context, request) =>
      getTenantOverview({
        db,
        ...adminTenantParamsSchema.parse(request.params),
      }),
    adminTenantEdit: (context, request) =>
      editTenant({
        db,
        actor: adminActor(context),
        ...adminTenantParamsSchema.parse(request.params),
        request: adminTenantEditRequestSchema.parse(request.body),
      }),
    adminTenantDisable: (context, request) =>
      disableTenant({
        db,
        actor: adminActor(context),
        ...adminTenantParamsSchema.parse(request.params),
      }),
    adminTenantEnable: (context, request) =>
      enableTenant({
        db,
        actor: adminActor(context),
        ...adminTenantParamsSchema.parse(request.params),
      }),
    adminTenantSettings: (context, request) =>
      updateTenantSettings({
        db,
        actor: adminActor(context),
        ...adminTenantParamsSchema.parse(request.params),
        amountRequests,
        request: amountRequests.settings.parse(request.body),
      }),
  };
}
