import { queryOptions } from '@tanstack/react-query';
import { adminApiContract, type ApiOperation } from '@fs-billing/shared';
import { apiKey } from './admin-api';
import { callOperation } from './api';
import {
  tenantUsageOverviewSchema,
  type TenantUsageOverview,
} from './usage-overview-mirror';

/**
 * 主干契约里的 overview 仍是旧响应；PR #24 合并前用镜像 schema 覆盖成功响应。
 * 合并后改回 `apiQuery('adminTenantOverview', …)` 并删除本覆盖。
 */
const overviewOperation = {
  ...adminApiContract.adminTenantOverview,
  responses: {
    ...adminApiContract.adminTenantOverview.responses,
    200: tenantUsageOverviewSchema,
  },
} satisfies ApiOperation;

export function tenantOverviewQuery(tenantId: string) {
  const input = { params: { tenantId } };
  return queryOptions({
    queryKey: apiKey('adminTenantOverview', input),
    // 成功响应已由上面的镜像 schema 解析。
    queryFn: () =>
      callOperation(overviewOperation, input) as Promise<TenantUsageOverview>,
  });
}
