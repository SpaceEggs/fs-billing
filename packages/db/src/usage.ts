import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import {
  tenantUsageOverviewSchema,
  type TenantUsageOverview,
} from '@fs-billing/shared';
import type { Tx } from './client.js';
import { NotFoundError } from './errors.js';

export function tenantMonthSpendSql(
  tenantId: SQLWrapper,
  asOf: SQL = sql`statement_timestamp()`,
): SQL<string> {
  return sql<string>`coalesce((
    select -sum(l.amount) from ledger_entries l
    where l.tenant_id = ${tenantId} and l.kind = 'call_charge'
      and l.occurred_at >= date_trunc('month', ${asOf} at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'
      and l.occurred_at < (date_trunc('month', ${asOf} at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai'
  ), 0)::text`;
}

export async function readTenantUsageOverview(
  tx: Tx,
  tenantId: string,
  now?: Date,
): Promise<TenantUsageOverview> {
  const instant = now
    ? sql`${now.toISOString()}::timestamptz`
    : sql`statement_timestamp()`;
  // 大租户要聚合上百万行，JIT 编译开销大于收益；只影响当前事务。
  // bounds 被多处引用会物化，daily_spend 用标量子查询取边界，日期条件才能进入流水索引，见 docs/perf/overview-explain.md。
  await tx.execute(sql`set local jit = off`);
  const { rows } = await tx.execute<{ overview: unknown }>(sql`
    with instant as (select ${instant} as as_of),
    bounds as (
      select as_of, (as_of at time zone 'Asia/Shanghai')::date as today,
        date_trunc('month', as_of at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' as month_start,
        (date_trunc('month', as_of at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai' as month_end
      from instant
    ),
    daily_spend as (
      select (l.occurred_at at time zone 'Asia/Shanghai')::date as day, -sum(l.amount) as spend
      from ledger_entries l
      where l.tenant_id = ${tenantId}::uuid and l.kind = 'call_charge'
        and l.occurred_at >= (select (today - 29)::timestamp at time zone 'Asia/Shanghai' from bounds)
        and l.occurred_at < (select (today + 1)::timestamp at time zone 'Asia/Shanghai' from bounds)
      group by 1
    ),
    days as (
      select b.today - n as day, coalesce(d.spend, 0) as spend
      from bounds b cross join generate_series(0, 29) n
      left join daily_spend d on d.day = b.today - n
    ),
    answered as (
      select coalesce(sum(c.billed_minutes), 0)::text as minutes, count(*)::int as calls
      from cdrs c cross join bounds b
      where c.tenant_id = ${tenantId}::uuid
        and c.answered_at >= b.month_start and c.answered_at < b.month_end
        and c.started_at < b.month_end
    ),
    unanswered as (
      select count(*)::int as calls
      from cdrs c cross join bounds b
      where c.tenant_id = ${tenantId}::uuid and c.answered_at is null
        and c.started_at >= b.month_start and c.started_at < b.month_end
    )
    select jsonb_build_object(
      'asOf', to_char(b.as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'currency', t.currency,
      'monthSpend', ${tenantMonthSpendSql(sql`t.id`, sql`b.as_of`)},
      'monthCallMinutes', a.minutes,
      'answeredCalls', a.calls,
      'unansweredCalls', u.calls,
      'daily', (select jsonb_agg(jsonb_build_object('date', day, 'spend', spend::text) order by day) from days),
      'dailyTotal', (select sum(spend)::text from days)
    ) as overview
    from tenants t cross join bounds b cross join answered a cross join unanswered u
    where t.id = ${tenantId}::uuid
  `);
  const row = rows[0];
  if (!row) throw new NotFoundError('租户不存在');
  return tenantUsageOverviewSchema.parse(row.overview);
}
