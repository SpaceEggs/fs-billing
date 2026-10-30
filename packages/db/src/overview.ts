import { sql, type SQL } from 'drizzle-orm';
import {
  OVERVIEW_ATTENTION_ITEMS,
  OVERVIEW_DAILY_DAYS,
  adminOverviewResponseSchema,
  type AdminOverviewResponse,
} from '@fs-billing/shared';
import { alertsInWindow, countOpenAlerts } from './alert-list.js';
import { cdrTimestamp } from './cdr-query.js';
import { withAdmin, type Db, type Tx } from './client.js';
import { readReceivableTotals } from './admin/receivables.js';
import { readTenantsByHealth } from './admin/tenants.js';
import { readUnassignedSummary } from './unassigned/list.js';

/**
 * 管理后台概览（阶段 9 设计「两个页面的数字」）。
 *
 * 同源而不是事后比对：待收款总额 = `readReceivableTotals`（待收款页的 `totals`）；告警数 = `alertsInWindow`
 * （告警页同一个谓词）；未归属 = `readUnassignedSummary`；已停机 / 余额不足 = `readTenantsByHealth`
 * （租户列表按状态筛选的同一个 SQL 片段）。其余指标沿用 design.md §7.7 的口径：消费只算通话扣费的绝对值，
 * 分钟取计费分钟，已接通按接通时间，日期按北京时间，CNY 与 USD 分开不相加；SQL 是 `usage.ts` 的租户口径
 * 去掉租户条件、按币种聚合（决定 9）。
 *
 * {@link getAdminOverview} 在一个 `repeatable read`、只读事务里取一致快照；{@link readAdminOverview}
 * 在调用方的事务里执行（测试在同一事务里与各页面的函数对照）。
 */

export interface OverviewOptions {
  /** 测试注入；默认取事务的 `now()`。 */
  readonly now?: Date | undefined;
}

const instantSql = (now?: Date): SQL =>
  now ? sql`${now.toISOString()}::timestamptz` : sql`now()`;

type AggregateRow = {
  as_of: string;
  tenant_count: number;
  today_minutes: string;
  minutes_cny: string;
  minutes_usd: string;
  suspended_cny: number;
  suspended_usd: number;
  today_cny: string;
  today_usd: string;
  month_cny: string;
  month_usd: string;
  daily: { date: string; CNY: string; USD: string }[];
};

export async function readAdminOverview(
  tx: Tx,
  options: OverviewOptions = {},
): Promise<AdminOverviewResponse> {
  const now = options.now;
  // 全租户的聚合要扫上百万行，JIT 编译开销大于收益；只影响当前事务（同 usage.ts）。
  await tx.execute(sql`set local jit = off`);
  // 边界用标量子查询（InitPlan），日期条件才能进入索引与分区剪枝。
  // 流水一次扫描：从「本月 1 日」与「29 天前」较早者到明天零点，按北京日、币种分组，再从中取今日、本月、近 30 天。
  // 话单：今日已接通的计费分钟；started_at 的下界只为分区剪枝（一通话单不会在开始一天之后才接通）。
  const { rows } = await tx.execute<AggregateRow>(sql`
    with instant as (select ${instantSql(now)} as as_of),
    bounds as (
      select as_of,
        (as_of at time zone 'Asia/Shanghai')::date as today,
        date_trunc('month', as_of at time zone 'Asia/Shanghai')::date as month_first
      from instant
    ),
    daily_spend as (
      select (l.occurred_at at time zone 'Asia/Shanghai')::date as day, t.currency, -sum(l.amount) as spend
      from ledger_entries l join tenants t on t.id = l.tenant_id
      where l.kind = 'call_charge'
        and l.occurred_at >= (select least(month_first, today - ${OVERVIEW_DAILY_DAYS - 1}::int)::timestamp at time zone 'Asia/Shanghai' from bounds)
        and l.occurred_at < (select (today + 1)::timestamp at time zone 'Asia/Shanghai' from bounds)
      group by 1, 2
    ),
    days as (
      select (select today from bounds) - n as day
      from generate_series(0, ${OVERVIEW_DAILY_DAYS - 1}::int) n
    ),
    minutes as (
      select coalesce(sum(c.billed_minutes), 0)::text as total,
        coalesce(sum(c.billed_minutes) filter (where t.currency = 'CNY'), 0)::text as cny,
        coalesce(sum(c.billed_minutes) filter (where t.currency = 'USD'), 0)::text as usd
      from cdrs c join tenants t on t.id = c.tenant_id
      where c.answered_at >= (select today::timestamp at time zone 'Asia/Shanghai' from bounds)
        and c.answered_at < (select (today + 1)::timestamp at time zone 'Asia/Shanghai' from bounds)
        and c.started_at >= (select today::timestamp at time zone 'Asia/Shanghai' - interval '1 day' from bounds)
        and c.started_at < (select (today + 1)::timestamp at time zone 'Asia/Shanghai' from bounds)
    )
    select ${cdrTimestamp(sql`b.as_of`)} as as_of,
      (select count(*)::int from tenants) as tenant_count,
      (select total from minutes) as today_minutes,
      (select cny from minutes) as minutes_cny,
      (select usd from minutes) as minutes_usd,
      (select count(*)::int from tenants t left join tenant_balances tb on tb.tenant_id = t.id where t.status <> 'disabled' and coalesce(tb.balance, 0) + t.overdraft_limit <= 0 and t.currency = 'CNY') as suspended_cny,
      (select count(*)::int from tenants t left join tenant_balances tb on tb.tenant_id = t.id where t.status <> 'disabled' and coalesce(tb.balance, 0) + t.overdraft_limit <= 0 and t.currency = 'USD') as suspended_usd,
      coalesce((select sum(spend) from daily_spend where day = b.today and currency = 'CNY'), 0)::text as today_cny,
      coalesce((select sum(spend) from daily_spend where day = b.today and currency = 'USD'), 0)::text as today_usd,
      coalesce((select sum(spend) from daily_spend where day >= b.month_first and currency = 'CNY'), 0)::text as month_cny,
      coalesce((select sum(spend) from daily_spend where day >= b.month_first and currency = 'USD'), 0)::text as month_usd,
      (select jsonb_agg(jsonb_build_object(
          'date', d.day,
          'CNY', coalesce((select sum(spend) from daily_spend s where s.day = d.day and s.currency = 'CNY'), 0)::text,
          'USD', coalesce((select sum(spend) from daily_spend s where s.day = d.day and s.currency = 'USD'), 0)::text
        ) order by d.day) from days d) as daily
    from bounds b`);
  const row = rows[0];
  if (!row) throw new Error('概览聚合没有返回结果');

  // 一个事务只有一条连接，而且各函数内部会开保存点：逐个执行，不并发。
  const receivable = await readReceivableTotals(tx, { status: 'pending' });
  const suspended = await readTenantsByHealth(
    tx,
    ['suspended'],
    OVERVIEW_ATTENTION_ITEMS,
  );
  const lowBalance = await readTenantsByHealth(
    tx,
    ['overdraft', 'low_balance'],
    OVERVIEW_ATTENTION_ITEMS,
  );
  const unassigned = await readUnassignedSummary(tx);
  const ids = [...suspended.items, ...lowBalance.items].map((item) => item.id);
  const details = ids.length
    ? (
        await tx.execute<{
          id: string;
          overdraft: string;
          threshold: string | null;
          suspended_at: string | null;
        }>(sql`
    select t.id, t.overdraft_limit::text as overdraft, s.threshold::text as threshold,
      ${cdrTimestamp(sql`n.suspended_at`)} as suspended_at
    from tenants t left join balance_alert_settings s on s.tenant_id = t.id
    left join balance_notice_state n on n.tenant_id = t.id
    where t.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`)
      ).rows
    : [];
  const enrich = (group: typeof suspended) => ({
    ...group,
    items: group.items.map((item) => {
      const detail = details.find((d) => d.id === item.id);
      if (!detail) throw new Error('概览租户详情缺失');
      return {
        ...item,
        overdraftLimit: detail.overdraft,
        threshold: detail.threshold,
        suspendedAt: detail.suspended_at,
      };
    }),
  });
  const latest = unassigned.pending
    ? ((
        await tx.execute<{ latest_at: string | null }>(sql`
    select ${cdrTimestamp(sql`coalesce(answered_at, started_at)`)} as latest_at from unassigned_cdrs
    where status = 'pending' order by coalesce(answered_at, started_at) desc, id limit 1`)
      ).rows[0]?.latest_at ?? null)
    : null;
  const alerts = await alertsInWindow(tx, {
    window: '24h',
    pageSize: OVERVIEW_ATTENTION_ITEMS,
    ...(now ? { now } : {}),
  });
  const open = await countOpenAlerts(tx);
  return adminOverviewResponseSchema.parse({
    asOf: row.as_of,
    metrics: {
      tenantCount: row.tenant_count,
      todayCallMinutes: row.today_minutes,
      todayCallMinutesByCurrency: {
        CNY: row.minutes_cny,
        USD: row.minutes_usd,
      },
      suspendedTenantsByCurrency: {
        CNY: row.suspended_cny,
        USD: row.suspended_usd,
      },
      todaySpend: { CNY: row.today_cny, USD: row.today_usd },
      monthSpend: { CNY: row.month_cny, USD: row.month_usd },
      pendingReceivable: receivable.totals,
      suspendedTenants: suspended.total,
    },
    attention: {
      suspended: enrich(suspended),
      lowBalance: enrich(lowBalance),
      unassigned: { pending: unassigned.pending, latestAt: latest },
      alerts: { open, last24h: alerts.total, items: alerts.items },
    },
    dailySpend: row.daily,
  });
}

/** 概览（一个快照）：`repeatable read` 只读事务，各部分取自同一时刻的数据。 */
export function getAdminOverview(
  db: Db | Tx,
  options: OverviewOptions = {},
): Promise<AdminOverviewResponse> {
  return withAdmin(db, (tx) => readAdminOverview(tx, options), {
    isolationLevel: 'repeatable read',
    accessMode: 'read only',
  });
}
