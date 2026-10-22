import { sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { currentStatementMonth, parseStatementMonth } from './months.js';

export const DEFAULT_STATEMENT_BACKFILL_MONTHS = 24;

/**
 * 租户第一个应有账单的北京月：创建时间与最早流水中较早者所在的月。
 * 取较早者是因为种子的 created_at 晚于流水，也容忍管理员回填的历史流水。租户不存在返回 null。
 */
export async function firstStatementMonth(
  tx: Tx,
  tenantId: string,
): Promise<string | null> {
  const { rows } = await tx.execute<{ month: string }>(sql`
    select to_char(date_trunc('month',
      least(t.created_at, coalesce(first_entry.occurred_at, t.created_at)) at time zone 'Asia/Shanghai'),
      'YYYY-MM-DD') as month
    from tenants t
    left join lateral (
      select occurred_at from ledger_entries e where e.tenant_id = t.id order by occurred_at limit 1
    ) first_entry on true
    where t.id = ${tenantId}::uuid`);
  return rows[0]?.month ?? null;
}

export interface MissingStatement {
  readonly tenantId: string;
  readonly tenantCode: string;
  /** 该月 1 日。 */
  readonly month: string;
}

export interface MissingStatementsOptions {
  /** 只看一个租户。 */
  readonly tenantId?: string;
  /** 最后一个应有月份。默认上一个北京月；种子用它固定上界。 */
  readonly through?: string;
  /** 最多补多少个月，默认 24；更早的缺口靠管理员重新生成补建。 */
  readonly backfillMonths?: number;
  /** 测试用的“现在”。 */
  readonly asOf?: Date;
}

/**
 * 应有而缺失的账单：所有租户（含已停用、含没有任何活动的）从第一个应有月份到上一个北京月，已有账单的跳过。
 * 只读，每天运行的生成任务据此扇出。
 */
export async function listMissingStatements(
  tx: Tx,
  options: MissingStatementsOptions = {},
): Promise<MissingStatement[]> {
  const through = options.through ? parseStatementMonth(options.through) : null;
  const backfill = options.backfillMonths ?? DEFAULT_STATEMENT_BACKFILL_MONTHS;
  if (!Number.isInteger(backfill) || backfill < 1)
    throw new Error('backfillMonths 必须是正整数');
  const current = await currentStatementMonth(tx, options.asOf);
  const { rows } = await tx.execute<{
    tenant_id: string;
    code: string;
    month: string;
  }>(sql`
    with last_month as (
      select coalesce(${through}::date, (${current}::date - interval '1 month')::date) as month
    ),
    firsts as (
      select t.id, t.code,
        date_trunc('month', least(t.created_at, coalesce(first_entry.occurred_at, t.created_at))
          at time zone 'Asia/Shanghai')::date as month
      from tenants t
      left join lateral (
        select occurred_at from ledger_entries e where e.tenant_id = t.id order by occurred_at limit 1
      ) first_entry on true
      where ${options.tenantId ?? null}::uuid is null or t.id = ${options.tenantId ?? null}::uuid
    )
    select f.id as tenant_id, f.code, to_char(m.month, 'YYYY-MM-DD') as month
    from firsts f
    cross join last_month l
    cross join lateral generate_series(
      greatest(f.month, (l.month - (${backfill}::int - 1) * interval '1 month')::date),
      l.month, interval '1 month') as m(month)
    where not exists (
      select 1 from monthly_statements s where s.tenant_id = f.id and s.month = m.month::date
    )
    order by f.code, m.month
  `);
  return rows.map((row) => ({
    tenantId: row.tenant_id,
    tenantCode: row.code,
    month: row.month,
  }));
}
