import {
  adminCdrsQuerySchema,
  adminCdrCountriesQuerySchema,
  adminTenantParamsSchema,
  portalCdrsQuerySchema,
  portalCdrCountriesQuerySchema,
} from '@fs-billing/shared';
import {
  listPortalCdrCountries,
  listPortalCdrs,
  listAdminCdrCountries,
  listAdminCdrs,
  type Db,
} from '@fs-billing/db';
import type { RequestContext } from '../types.js';
import { ApiFailure } from '../errors.js';
import type { RouteHandlers } from './register.js';

function customerTenant(context: RequestContext) {
  if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
  return context.principal.tenantId;
}

export function cdrHandlers(
  db: Db,
): Pick<
  RouteHandlers,
  | 'portalCdrs'
  | 'portalCdrCountries'
  | 'adminTenantCdrs'
  | 'adminTenantCdrCountries'
> {
  return {
    portalCdrs: (context, request) =>
      listPortalCdrs({
        db,
        tenantId: customerTenant(context),
        query: portalCdrsQuerySchema.parse(request.query),
      }),
    portalCdrCountries: (context, request) => {
      const query = portalCdrCountriesQuerySchema.parse(request.query);
      return listPortalCdrCountries({
        db,
        tenantId: customerTenant(context),
        from: query.from,
        to: query.to,
      });
    },
    adminTenantCdrs: (_context, request) =>
      listAdminCdrs({
        db,
        ...adminTenantParamsSchema.parse(request.params),
        query: adminCdrsQuerySchema.parse(request.query),
      }),
    adminTenantCdrCountries: (_context, request) => {
      const query = adminCdrCountriesQuerySchema.parse(request.query);
      return listAdminCdrCountries({
        db,
        ...adminTenantParamsSchema.parse(request.params),
        from: query.from,
        to: query.to,
      });
    },
  };
}
