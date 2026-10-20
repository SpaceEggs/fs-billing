import { sql } from 'drizzle-orm';
import type { TenantHealth } from '@fs-billing/shared';
import { balanceAlertSettings, tenantBalances, tenants } from './schema.js';

/**
 * 租户余额与状态的 SQL 片段，后台列表、详情和门户首页共用一份定义。
 * 引用 tenants、tenant_balances、balance_alert_settings 三张表的列，
 * 查询必须 left join 后两张表（余额或提醒设置缺失时按 0 和未配置处理）。
 */
export const tenantBalanceText = sql<string>`coalesce(${tenantBalances.balance}, 0)::text`;
export const tenantAvailableText = sql<string>`(coalesce(${tenantBalances.balance}, 0) + ${tenants.overdraftLimit})::text`;

/** 手动停用优先，其余按余额判定，见 docs/phase-5-design.md。 */
export const tenantHealth = sql<TenantHealth>`case
 when ${tenants.status} = 'disabled' then 'disabled'
 when coalesce(${tenantBalances.balance},0) + ${tenants.overdraftLimit} <= 0 then 'suspended'
 when coalesce(${tenantBalances.balance},0) < 0 then 'overdraft'
 when ${balanceAlertSettings.tenantId} is not null and coalesce(${tenantBalances.balance},0) < ${balanceAlertSettings.threshold} then 'low_balance'
 else 'normal' end`;
