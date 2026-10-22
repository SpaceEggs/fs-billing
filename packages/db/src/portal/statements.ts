import {
  portalStatementResponseSchema,
  portalStatementsResponseSchema,
  type PortalStatementResponse,
  type PortalStatementsResponse,
} from '@fs-billing/shared';
import { withTenant, type Db } from '../client.js';
import {
  monthKey,
  readStatementMonthList,
  readStatementView,
} from '../statements/index.js';

const iso = (value: Date) => value.toISOString();

/**
 * 门户月账单列表：从第一个应有月份到当前北京月，降序，不分页。租户只来自会话，RLS 限定。
 * 逐字段取用：版本、生成人、核对状态、差额不会进入响应。
 */
export function listPortalStatements({
  db,
  tenantId,
}: {
  db: Db;
  tenantId: string;
}): Promise<PortalStatementsResponse> {
  return withTenant(db, tenantId, async (tx) => {
    const list = await readStatementMonthList(tx, tenantId);
    return portalStatementsResponseSchema.parse({
      currency: list.tenant.currency,
      asOf: iso(list.asOf),
      items: list.items.map((item) => ({
        month: monthKey(item.month),
        state: item.state,
        figures: item.figures,
        generatedAt: item.header ? iso(item.header.generatedAt) : null,
        detailsDeleted: item.header?.detailsDeleted ?? false,
      })),
    });
  });
}

/**
 * 门户月账单详情。没有账单、也不是进行中或待生成的月份（早于第一个应有月份，包括别的租户独有的月份）
 * 抛 NotFoundError，与从不存在的月份无法区分；晚于当前北京月是 400。
 */
export function readPortalStatement({
  db,
  tenantId,
  month,
}: {
  db: Db;
  tenantId: string;
  month: string;
}): Promise<PortalStatementResponse> {
  return withTenant(db, tenantId, async (tx) => {
    const view = await readStatementView(tx, tenantId, month);
    return portalStatementResponseSchema.parse({
      currency: view.tenant.currency,
      tenant: { code: view.tenant.code, name: view.tenant.name },
      month: monthKey(view.month),
      state: view.state,
      period: view.period,
      asOf: view.asOf ? iso(view.asOf) : null,
      generatedAt: view.header ? iso(view.header.generatedAt) : null,
      detailsDeleted: view.header?.detailsDeleted ?? false,
      figures: view.figures,
      countries: view.countries,
      days: view.days,
    });
  });
}
