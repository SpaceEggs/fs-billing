import { eq, sql } from 'drizzle-orm';
import {
  PORTAL_HOME_RECENT_CALLS,
  portalHomeResponseSchema,
  type PortalHomeResponse,
} from '@fs-billing/shared';
import { withTenant, type Db, type Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import { balanceAlertSettings, tenantBalances, tenants } from '../schema.js';
import {
  tenantAvailableText,
  tenantBalanceText,
  tenantHealth,
} from '../tenant-health.js';
import { readTenantUsageOverview } from '../usage.js';
import { portalCdrProjection } from './cdrs.js';

async function readTenantBalances(tx: Tx, tenantId: string) {
  const [row] = await tx
    .select({
      currency: tenants.currency,
      balance: tenantBalanceText,
      overdraftLimit: sql<string>`${tenants.overdraftLimit}::text`,
      availableBalance: tenantAvailableText,
      health: tenantHealth,
    })
    .from(tenants)
    .leftJoin(tenantBalances, eq(tenantBalances.tenantId, tenants.id))
    .leftJoin(
      balanceAlertSettings,
      eq(balanceAlertSettings.tenantId, tenants.id),
    )
    .where(eq(tenants.id, tenantId));
  if (!row) throw new NotFoundError('租户不存在');
  return row;
}

/** 只含已接通，不加日期下界：Merge Append 取各分区前 10 条，见 docs/phase-6-design.md 门户首页。 */
async function readRecentCalls(tx: Tx, tenantId: string) {
  const { rows } = await tx.execute<{ call: unknown }>(sql`
    select ${portalCdrProjection('c')} as call
    from cdrs c
    where c.tenant_id = ${tenantId}::uuid and c.answered_at is not null
    order by c.answered_at desc, c.call_uuid desc
    limit ${PORTAL_HOME_RECENT_CALLS}
  `);
  return rows.map((row) => row.call);
}

/**
 * 门户首页：余额与状态、最近 30 天消费、最近 10 通已接通话单，同一个租户事务。
 * 消费指标沿用后台概况的查询，逐字段取用，不展开，所以后台才有的未接通通数进不了门户响应。
 */
export function readPortalHome({
  db,
  tenantId,
  now,
}: {
  db: Db;
  tenantId: string;
  now?: Date;
}): Promise<PortalHomeResponse> {
  return withTenant(db, tenantId, async (tx) => {
    const account = await readTenantBalances(tx, tenantId);
    const overview = await readTenantUsageOverview(tx, tenantId, now);
    const recentCalls = await readRecentCalls(tx, tenantId);
    return portalHomeResponseSchema.parse({
      currency: account.currency,
      balance: account.balance,
      overdraftLimit: account.overdraftLimit,
      availableBalance: account.availableBalance,
      health: account.health,
      usage: {
        asOf: overview.asOf,
        monthSpend: overview.monthSpend,
        monthCallMinutes: overview.monthCallMinutes,
        answeredCalls: overview.answeredCalls,
        daily: overview.daily,
        dailyTotal: overview.dailyTotal,
      },
      recentCalls,
    });
  });
}
