import { and, eq, sql } from 'drizzle-orm';
import { withAdmin, type Db, type Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import { admins, monthlyStatements, tenants } from '../schema.js';
import { firstStatementMonth } from '../statements/first-month.js';
import {
  addMonths,
  currentStatementMonth,
  monthKey,
  monthRange,
} from '../statements/months.js';

/**
 * 删除话单的月份状态（阶段 8「月份可选规则」）：
 * deletable 有账单行、话单未删除、月份已结束、核对通过（ok）且没有「有费用而无流水」的话单；
 * deleted 话单已删除；no_statement 月份已结束而没有账单行，或是当前月；
 * before_opening 早于第一个应有账单的月份（租户创建月与最早流水所在月中较早者）；future 晚于当前北京月；
 * blocked 有账单行但核对不是 ok，或有话单尚未扣费（决定 39）。
 */
export type CdrMonthState =
  | 'deletable'
  | 'deleted'
  | 'no_statement'
  | 'before_opening'
  | 'future'
  | 'blocked';

export type CdrMonthBlockedReason = 'reconcile_not_ok' | 'uncharged_calls';

export interface CdrDeletionMonth {
  /** YYYY-MM。 */
  readonly month: string;
  readonly state: CdrMonthState;
  /**
   * deletable / blocked：该月的话单条数（与话单列表同一个月份谓词）；
   * deleted：删除时记录的条数（旧标志没有元数据时为 null）；其他状态为 null。
   */
  readonly cdrCount: number | null;
  readonly blockedReasons: readonly CdrMonthBlockedReason[];
  readonly statementId: string | null;
  readonly deleted: {
    readonly at: Date | null;
    readonly by: { readonly id: string; readonly name: string } | null;
  } | null;
}

export interface DeletionTenant {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly createdAt: Date;
}

export async function loadDeletionTenant(
  tx: Tx,
  tenantId: string,
): Promise<DeletionTenant> {
  const [tenant] = await tx
    .select({
      id: tenants.id,
      code: tenants.code,
      name: tenants.name,
      createdAt: tenants.createdAt,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new NotFoundError('租户不存在');
  return tenant;
}

interface MonthFacts {
  readonly cdrs: number;
  readonly uncharged: number;
}

/**
 * [firstMonth, lastMonth] 每个北京月的话单条数与「有费用而无流水」条数。
 * 月份谓词与话单列表、导出一致（coalesce(answered_at, started_at)），
 * started_at 的上下界让数据库只扫相关分区（振铃不超过 31 天的假设沿用阶段 6）。
 */
async function readMonthFacts(
  tx: Tx,
  tenantId: string,
  firstMonth: string,
  lastMonth: string,
): Promise<Map<string, MonthFacts>> {
  const { lo } = monthRange(firstMonth);
  const { hi } = monthRange(lastMonth);
  // 条数与「有费用而无流水」分两个聚合：后者的 NOT EXISTS 写在 WHERE 里，数据库做哈希反连接；
  // 写在 FILTER 里会变成逐行的嵌套循环，慢三倍以上。通话扣费流水的 occurred_at 就是接通时间，
  // 所以只需在同一个月份范围内找流水（走 tenant_id + occurred_at 索引）；位置不对的流水按「未扣费」处理，偏向拒绝删除。
  const { rows } = await tx.execute<{
    month: string;
    cdrs: number;
    uncharged: number;
  }>(sql`
    with counted as (
      select to_char(date_trunc('month', coalesce(c.answered_at, c.started_at) at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as month,
        count(*)::int as cdrs
      from cdrs c
      where c.tenant_id = ${tenantId}::uuid
        and coalesce(c.answered_at, c.started_at) >= ${lo}
        and coalesce(c.answered_at, c.started_at) < ${hi}
        and c.started_at >= ${lo} - interval '31 days'
        and c.started_at < ${hi}
      group by 1),
    missing as (
      select to_char(date_trunc('month', c.answered_at at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as month,
        count(*)::int as uncharged
      from cdrs c
      where c.tenant_id = ${tenantId}::uuid
        and c.charge > 0
        and c.answered_at >= ${lo}
        and c.answered_at < ${hi}
        and c.started_at >= ${lo} - interval '31 days'
        and c.started_at < ${hi}
        and not exists (
          select 1 from ledger_entries l
          where l.tenant_id = c.tenant_id and l.kind = 'call_charge'
            and l.occurred_at >= ${lo} and l.occurred_at < ${hi}
            and l.idempotency_key = 'call:' || c.call_uuid::text)
      group by 1)
    select counted.month, counted.cdrs, coalesce(missing.uncharged, 0)::int as uncharged
    from counted left join missing using (month)`);
  return new Map(
    rows.map((row) => [
      row.month,
      { cdrs: row.cdrs, uncharged: row.uncharged },
    ]),
  );
}

/**
 * 给定月份（YYYY-MM-01，升序、连续或不连续均可）的删除状态。
 * 删除事务在租户锁内对要删的月份再调用一次：锁内读到的核对状态与话单就是最新已提交的。
 */
export async function readCdrDeletionMonths(
  tx: Tx,
  tenant: DeletionTenant,
  months: readonly string[],
): Promise<CdrDeletionMonth[]> {
  if (months.length === 0) return [];
  const current = await currentStatementMonth(tx);
  // 第一个应有账单的月份（创建月与最早流水所在月中较早者，和账单生成任务一致）。
  const opening = (await firstStatementMonth(tx, tenant.id)) ?? current;
  const statementRows = await tx
    .select({
      id: monthlyStatements.id,
      month: monthlyStatements.month,
      detailsDeleted: monthlyStatements.detailsDeleted,
      reconcileStatus: monthlyStatements.reconcileStatus,
      deletedAt: monthlyStatements.detailsDeletedAt,
      deletedCount: monthlyStatements.detailsDeletedCount,
      deletedById: admins.id,
      deletedByName: admins.name,
    })
    .from(monthlyStatements)
    .leftJoin(admins, eq(admins.id, monthlyStatements.detailsDeletedBy))
    .where(and(eq(monthlyStatements.tenantId, tenant.id)));
  const statements = new Map(statementRows.map((row) => [row.month, row]));
  const needFacts = months.filter((month) => {
    const row = statements.get(month);
    return (
      month < current &&
      month >= opening &&
      row !== undefined &&
      !row.detailsDeleted
    );
  });
  const facts =
    needFacts.length === 0
      ? new Map<string, MonthFacts>()
      : await readMonthFacts(
          tx,
          tenant.id,
          needFacts[0]!,
          needFacts[needFacts.length - 1]!,
        );

  return months.map((month): CdrDeletionMonth => {
    const base = {
      month: monthKey(month),
      cdrCount: null,
      blockedReasons: [] as CdrMonthBlockedReason[],
      statementId: null,
      deleted: null,
    };
    if (month > current) return { ...base, state: 'future' };
    if (month === current) return { ...base, state: 'no_statement' };
    if (month < opening) return { ...base, state: 'before_opening' };
    const row = statements.get(month);
    if (!row) return { ...base, state: 'no_statement' };
    if (row.detailsDeleted)
      return {
        ...base,
        state: 'deleted',
        cdrCount: row.deletedCount,
        statementId: row.id,
        deleted: {
          at: row.deletedAt,
          by:
            row.deletedById !== null && row.deletedByName !== null
              ? { id: row.deletedById, name: row.deletedByName }
              : null,
        },
      };
    const fact = facts.get(month) ?? { cdrs: 0, uncharged: 0 };
    const blockedReasons: CdrMonthBlockedReason[] = [];
    if (row.reconcileStatus !== 'ok') blockedReasons.push('reconcile_not_ok');
    if (fact.uncharged > 0) blockedReasons.push('uncharged_calls');
    return {
      ...base,
      state: blockedReasons.length === 0 ? 'deletable' : 'blocked',
      cdrCount: fact.cdrs,
      blockedReasons,
      statementId: row.id,
    };
  });
}

/** 租户某年 12 个月的删除状态（后台月份格），只读。 */
export async function listCdrDeletionMonths(
  db: Db | Tx,
  input: { tenantId: string; year: number },
): Promise<CdrDeletionMonth[]> {
  if (!Number.isInteger(input.year) || input.year < 1 || input.year > 9999)
    throw new RangeError('年份必须是 1 至 9999 的整数');
  const first = `${String(input.year).padStart(4, '0')}-01-01`;
  return withAdmin(db, async (tx) => {
    const tenant = await loadDeletionTenant(tx, input.tenantId);
    return readCdrDeletionMonths(
      tx,
      tenant,
      Array.from({ length: 12 }, (_, index) => addMonths(first, index)),
    );
  });
}
