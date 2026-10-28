import { deleteCdrMonths, readCdrDeletionYear, type Db } from '@fs-billing/db';
import {
  adminCdrDeletionApiContract,
  adminTenantParamsSchema,
} from '@fs-billing/shared';
import type { RouteHandlers } from './register.js';
import { mapBusinessErrors } from './business-errors.js';
import { adminActor } from './admin/tenants.js';

const requests = adminCdrDeletionApiContract;

export function cdrDeletionHandlers(
  db: Db,
): Pick<
  RouteHandlers,
  'adminTenantCdrDeletionMonths' | 'adminTenantCdrDelete'
> {
  return {
    adminTenantCdrDeletionMonths: async (_context, request) => {
      const { tenantId } = adminTenantParamsSchema.parse(request.params);
      const { year } =
        requests.adminTenantCdrDeletionMonths.request.query.parse(
          request.query,
        );
      const { tenant, months } = await readCdrDeletionYear(db, {
        tenantId,
        year,
      });
      return {
        tenant: { id: tenant.id, code: tenant.code, name: tenant.name },
        year,
        months: months.map((month) => ({
          ...month,
          deleted: month.deleted && {
            by: month.deleted.by,
            at: month.deleted.at?.toISOString() ?? null,
          },
        })),
      };
    },
    adminTenantCdrDelete: async (context, request) => {
      const { tenantId } = adminTenantParamsSchema.parse(request.params);
      const body = requests.adminTenantCdrDelete.request.body.parse(
        request.body,
      );
      const result = await mapBusinessErrors(() =>
        deleteCdrMonths(db, { ...body, tenantId, actor: adminActor(context) }),
      );
      const { failure } = result;
      if (failure?.code === 'INTERNAL')
        request.log.error(
          { err: failure.error, requestId: request.id, month: failure.month },
          'CDR deletion stopped part way',
        );
      return {
        months: result.months,
        total: result.total,
        remaining: result.remaining,
        // 内部错误的原文可能带数据库细节，不返回；其余是业务拒绝，消息是固定中文。
        failure: failure && {
          month: failure.month,
          code: failure.code,
          message:
            failure.code === 'INTERNAL'
              ? '服务内部错误，已删除的月份保留，请稍后重试剩余月份'
              : failure.message,
        },
      };
    },
  };
}
