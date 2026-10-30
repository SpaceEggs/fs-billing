import { getAdminOverview, type Db } from '@fs-billing/db';
import type { RouteHandlers } from './register.js';

/** 概览：一个 repeatable read 快照里取全部数字（packages/db/src/overview.ts）。 */
export function overviewHandlers(db: Db): Pick<RouteHandlers, 'adminOverview'> {
  return { adminOverview: () => getAdminOverview(db) };
}
