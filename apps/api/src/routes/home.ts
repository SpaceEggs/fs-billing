import { readPortalHome, type Db } from '@fs-billing/db';
import { ApiFailure } from '../errors.js';
import type { RouteHandlers } from './register.js';

export function homeHandlers(db: Db): Pick<RouteHandlers, 'portalHome'> {
  return {
    portalHome: (context) => {
      if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
      return readPortalHome({ db, tenantId: context.principal.tenantId });
    },
  };
}
