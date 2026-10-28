import { listAuditLogs, type Db } from '@fs-billing/db';
import { adminAuditLogsQuerySchema } from '@fs-billing/shared';
import type { RouteHandlers } from './register.js';

export function auditLogHandlers(
  db: Db,
): Pick<RouteHandlers, 'adminAuditLogs'> {
  return {
    adminAuditLogs: async (_context, request) => {
      const query = adminAuditLogsQuerySchema.parse(request.query);
      const list = await listAuditLogs(db, query);
      return {
        range: list.range,
        items: list.items,
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: list.total,
        },
      };
    },
  };
}
