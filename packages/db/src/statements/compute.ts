import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { canonical } from './decimal.js';
import { monthRange, parseStatementMonth } from './months.js';
import type {
  StatementComputation,
  StatementCountryRow,
  StatementDayRow,
} from './types.js';

export interface ComputeOptions {
  /**
   * 统计截止时刻（不含）。默认到月末；进行中的月份传 statement_timestamp()，
   * 之后的流水与话单不计入。
   */
  readonly asOf?: Date;
  /**
   * 期初怎么取：`ledger`（默认）是月初前流水合计，任何月份都成立；
   * `balance` 是缓存余额减去月初起的流水合计，只在当前月（月初之后的流水都在读取时刻之前）有意义，
   * 大租户上比扫全部历史流水快得多。两者在账本一致时相等。
   */
  readonly opening?: 'ledger' | 'balance';
}

interface ComputeRow extends Record<string, unknown> {
  opening_balance: string;
  recharge: string;
  gift: string;
  adjustment: string;
  call_charges: string;
  closing_balance: string;
  calls: number;
  call_minutes: string;
  breakdown_gap: string;
  countries: {
    country: string;
    calls: number;
    minutes: string;
    charge: string;
  }[];
  days: { day: string; calls: number; minutes: string; charge: string }[];
}

/**
 * 一个租户一个北京月的账单取数。只读。
 *
 * 头部六个数来自流水（occurred_at 的北京月，不看 created_at），通话数、计费分钟、按国家与按日明细来自话单
 * （answered_at 的北京月/日，跨午夜、跨月归接通时刻），二者各自独立，不互相推导；
 * breakdown_gap 记录二者的差额。全部在一条语句里读出，所以头部与明细一定来自同一个快照，
 * 不论调用方的隔离级别。金额不舍入。
 */
export async function computeStatement(
  tx: Tx,
  tenantId: string,
  monthInput: string,
  options: ComputeOptions = {},
): Promise<StatementComputation> {
  const month = parseStatementMonth(monthInput);
  const { lo: monthLo, hi: monthHi } = monthRange(month);
  const opening =
    options.opening === 'balance'
      ? sql`(select balance from tenant_balances where tenant_id = ${tenantId}::uuid)
          - (select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = ${tenantId}::uuid and occurred_at >= (select lo from bounds))`
      : sql`(select coalesce(sum(amount), 0) from ledger_entries
             where tenant_id = ${tenantId}::uuid and occurred_at < (select lo from bounds))`;
  // 大租户要聚合上百万行，JIT 编译开销大于收益（同首页概况）；只影响当前事务。
  await tx.execute(sql`set local jit = off`);
  const { rows } = await tx.execute<ComputeRow>(sql`
    with bounds as (
      select ${monthLo} as lo, least(${monthHi}, ${options.asOf?.toISOString() ?? null}::timestamptz) as hi
    ),
    opening as (select ${opening} as amount),
    flows as (
      select
        coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
        coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
        coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
        coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
      from ledger_entries
      where tenant_id = ${tenantId}::uuid
        and occurred_at >= (select lo from bounds) and occurred_at < (select hi from bounds)
    ),
    by_country as (
      select c.country, count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = ${tenantId}::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by c.country
    ),
    by_day as (
      select (c.answered_at at time zone 'Asia/Shanghai')::date as day,
        count(*)::int as calls, sum(c.billed_minutes) as minutes, sum(c.charge) as charge
      from cdrs c
      where c.tenant_id = ${tenantId}::uuid
        and c.answered_at >= (select lo from bounds) and c.answered_at < (select hi from bounds)
        and c.started_at >= (select lo - interval '31 days' from bounds) and c.started_at < (select hi from bounds)
      group by 1
    )
    select
      o.amount::text as opening_balance,
      f.recharge::text as recharge,
      f.gift::text as gift,
      f.adjustment::text as adjustment,
      f.call_charges::text as call_charges,
      (o.amount + f.recharge + f.gift + f.adjustment - f.call_charges)::text as closing_balance,
      (select coalesce(sum(calls), 0)::int from by_country) as calls,
      (select coalesce(sum(minutes), 0)::text from by_country) as call_minutes,
      (f.call_charges - (select coalesce(sum(charge), 0) from by_country))::text as breakdown_gap,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'country', country, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by charge desc, country), '[]'::jsonb) from by_country) as countries,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'day', day::text, 'calls', calls, 'minutes', minutes::text, 'charge', charge::text)
          order by day), '[]'::jsonb) from by_day) as days
    from opening o cross join flows f
  `);
  const row = rows[0];
  if (!row) throw new Error('账单取数没有返回行');
  const countries: StatementCountryRow[] = row.countries.map((entry) => ({
    country: entry.country,
    calls: entry.calls,
    minutes: canonical(entry.minutes),
    charge: canonical(entry.charge),
  }));
  const days: StatementDayRow[] = row.days.map((entry) => ({
    day: entry.day,
    calls: entry.calls,
    minutes: canonical(entry.minutes),
    charge: canonical(entry.charge),
  }));
  return {
    openingBalance: canonical(row.opening_balance),
    recharge: canonical(row.recharge),
    gift: canonical(row.gift),
    adjustment: canonical(row.adjustment),
    callCharges: canonical(row.call_charges),
    closingBalance: canonical(row.closing_balance),
    calls: row.calls,
    callMinutes: canonical(row.call_minutes),
    breakdownGap: canonical(row.breakdown_gap),
    countries,
    days,
  };
}
