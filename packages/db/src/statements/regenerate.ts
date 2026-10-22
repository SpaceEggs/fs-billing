import { and, eq, sql } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { NotFoundError } from '../errors.js';
import { monthlyStatements, tenants } from '../schema.js';
import { computeStatement } from './compute.js';
import { StatementError } from './errors.js';
import { firstStatementMonth } from './first-month.js';
import {
  assertSnapshotTransaction,
  currentStatementMonth,
  monthKey,
  parseStatementMonth,
} from './months.js';
import {
  appendDetails,
  insertStatement,
  readStatement,
  readStatementDetails,
  readStatementHeader,
} from './store.js';
import {
  STATEMENT_FIGURE_KEYS,
  type StatementComputation,
  type StatementFigures,
  type StoredStatement,
} from './types.js';

export type StatementVersionFigures = StatementFigures & {
  readonly version: number;
};

export interface RegenerateResult {
  /** 重新生成之后的账单（无变化时即现有账单）。 */
  readonly statement: StoredStatement;
  /** 之前的数字；月份原本没有账单行（补建）时为 null。 */
  readonly before: StatementVersionFigures | null;
  readonly after: StatementVersionFigures;
  /** 数字与明细都和现有账单完全相同时为 false：不加版本、不写新明细、不动时间戳。 */
  readonly changed: boolean;
  /** 月份原本没有账单行，这次是补建。 */
  readonly created: boolean;
  /** 此刻期初与账本不符的后续账单月份，提示管理员按月份顺序逐个重新生成。 */
  readonly staleFollowingMonths: readonly string[];
}

const figuresOf = (
  source: StatementFigures & { version: number },
): StatementVersionFigures => ({
  openingBalance: source.openingBalance,
  recharge: source.recharge,
  gift: source.gift,
  adjustment: source.adjustment,
  callCharges: source.callCharges,
  closingBalance: source.closingBalance,
  calls: source.calls,
  callMinutes: source.callMinutes,
  version: source.version,
});

/**
 * 管理员手动重新生成一个月份的账单，只处理被点的这个月（后续月份的期初过期由返回值提示，不级联）。
 *
 * 必须在 `repeatable read` 事务里调用（`withAdmin(db, fn, { isolationLevel: 'repeatable read' })`）。
 * 顺序：租户与月份存在 → 月份已结束 → 锁账单头部 → expectedVersion 相符 → 话单未删除 → 重新取数。
 * - `expectedVersion` 是对话框打开时看到的版本；月份没有账单行时必须是 0，这时等同补建（version = 1）。
 * - 数字或明细有变化：头部原地更新（version + 1、新数字、generated_at、generated_by、核对状态复位），
 *   追加新版本的明细，旧版本明细保留。完全相同：什么都不写，`changed` 为 false。
 * 操作日志由调用方在同一事务里写（需要 before/after）。
 */
export async function regenerateStatement(
  tx: Tx,
  tenantId: string,
  monthInput: string,
  options: { expectedVersion: number; adminId: string },
): Promise<RegenerateResult> {
  const month = parseStatementMonth(monthInput);
  await assertSnapshotTransaction(tx);
  const [tenant] = await tx
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.id, tenantId));
  if (!tenant) throw new NotFoundError('租户不存在');
  const first = await firstStatementMonth(tx, tenantId);
  if (first === null || month < first)
    throw new NotFoundError(`${monthKey(month)} 早于租户的第一个账单月份`);
  if (month >= (await currentStatementMonth(tx)))
    throw new StatementError(
      'STATEMENT_NOT_FINAL',
      `${monthKey(month)} 尚未结束，月结后才能重新生成`,
    );

  const header = await readStatementHeader(tx, tenantId, month, {
    forUpdate: true,
  });
  const currentVersion = header?.version ?? 0;
  if (currentVersion !== options.expectedVersion)
    throw new StatementError(
      'STATEMENT_VERSION_CONFLICT',
      `账单版本已是 ${currentVersion}，不是 ${options.expectedVersion}，请刷新后重试`,
    );
  if (header?.detailsDeleted)
    throw new StatementError(
      'STATEMENT_DETAILS_DELETED',
      `${monthKey(month)} 的话单已删除，无法重新计算`,
    );

  const computation = await computeStatement(tx, tenantId, month);

  if (!header) {
    const id = await insertStatement(
      tx,
      tenantId,
      month,
      computation,
      options.adminId,
    );
    if (id === null) throw new Error('补建账单时月份已有账单行');
    const created = (await readStatement(tx, tenantId, month))!;
    return {
      statement: created,
      before: null,
      after: figuresOf(created),
      changed: true,
      created: true,
      staleFollowingMonths: await staleFollowingMonths(tx, tenantId, month),
    };
  }

  const stored: StoredStatement = {
    ...header,
    ...(await readStatementDetails(tx, header)),
  };
  if (sameStatement(stored, computation)) {
    return {
      statement: stored,
      before: figuresOf(stored),
      after: figuresOf(stored),
      changed: false,
      created: false,
      staleFollowingMonths: await staleFollowingMonths(tx, tenantId, month),
    };
  }

  const version = header.version + 1;
  await tx
    .update(monthlyStatements)
    .set({
      version,
      openingBalance: computation.openingBalance,
      recharge: computation.recharge,
      gift: computation.gift,
      adjustment: computation.adjustment,
      callCharges: computation.callCharges,
      closingBalance: computation.closingBalance,
      callMinutes: computation.callMinutes,
      calls: computation.calls,
      breakdownGap: computation.breakdownGap,
      generatedAt: sql`now()`,
      generatedBy: options.adminId,
      reconcileStatus: 'unchecked',
      reconciledAt: null,
      reconcileDiff: null,
    })
    .where(
      and(
        eq(monthlyStatements.id, header.id),
        eq(monthlyStatements.version, header.version),
      ),
    );
  await appendDetails(tx, header.id, tenantId, version, computation);
  const updated = (await readStatement(tx, tenantId, month))!;
  return {
    statement: updated,
    before: figuresOf(header),
    after: figuresOf(updated),
    changed: true,
    created: false,
    staleFollowingMonths: await staleFollowingMonths(tx, tenantId, month),
  };
}

/** 头部数字、差额、国家与日明细都相同。 */
function sameStatement(
  stored: StoredStatement,
  computation: StatementComputation,
): boolean {
  return (
    STATEMENT_FIGURE_KEYS.every((key) => stored[key] === computation[key]) &&
    stored.breakdownGap === computation.breakdownGap &&
    JSON.stringify(stored.countries) ===
      JSON.stringify(computation.countries) &&
    JSON.stringify(stored.days) === JSON.stringify(computation.days)
  );
}

/**
 * 给定月份之后、期初与账本不符的账单月份（升序）。补推一笔 8 月的扣费，9 月账单里存的期初就过期了。
 * 一次按月汇总扫描，不逐月求和。
 */
export async function staleFollowingMonths(
  tx: Tx,
  tenantId: string,
  monthInput: string,
): Promise<string[]> {
  const { rows } = await tx.execute<{ month: string }>(sql`
    with monthly as (
      select date_trunc('month', occurred_at at time zone 'Asia/Shanghai')::date as month, sum(amount) as amount
      from ledger_entries where tenant_id = ${tenantId}::uuid group by 1
    )
    select to_char(s.month, 'YYYY-MM-DD') as month
    from monthly_statements s
    where s.tenant_id = ${tenantId}::uuid and s.month > ${parseStatementMonth(monthInput)}::date
      and s.opening_balance <> coalesce((select sum(m.amount) from monthly m where m.month < s.month), 0)
    order by s.month`);
  return rows.map((row) => row.month);
}
