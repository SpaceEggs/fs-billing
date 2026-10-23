import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { beijingDay } from '@fs-billing/rating';
import type { AuditPayload } from '@fs-billing/shared';
import { writeAudit } from '../admin/audit.js';
import { lockTenants, withAdmin, type Db, type Tx } from '../client.js';
import { monthlyStatements } from '../schema.js';
import {
  addMonths,
  monthKey,
  monthRange,
  parseStatementMonth,
} from '../statements/months.js';
import { CdrDeletionError } from './errors.js';
import {
  loadDeletionTenant,
  readCdrDeletionMonths,
  type DeletionTenant,
} from './months.js';

/** 一次请求最多展开的月份数；只是防止异常输入，正常使用远小于它。 */
export const CDR_DELETE_MAX_MONTHS = 120;

export interface DeleteCdrMonthsInput {
  readonly actor: AuditPayload['actor'];
  readonly tenantId: string;
  /** YYYY-MM。 */
  readonly fromMonth: string;
  readonly toMonth: string;
  /** 二次确认：必须与 tenants.code 完全相等（区分大小写）。 */
  readonly tenantCode: string;
  /** 预览时看到的、范围内全部月份的话单条数之和。 */
  readonly expectedCount: number;
}

export interface DeletedMonth {
  /** YYYY-MM。 */
  readonly month: string;
  readonly deleted: number;
  readonly statementId: string;
  readonly auditId: string;
}

export interface DeleteCdrMonthsResult {
  readonly months: readonly DeletedMonth[];
  readonly total: number;
  /** 没有处理的月份（YYYY-MM）：中途失败后重试只处理这些。 */
  readonly remaining: readonly string[];
  /** 中途失败：已完成的月份保留；全部成功为 null。 */
  readonly failure: {
    readonly month: string;
    readonly code: CdrDeletionError['code'] | 'INTERNAL';
    readonly message: string;
    readonly error: unknown;
  } | null;
}

function expandMonths(fromMonth: string, toMonth: string): string[] {
  let from: string;
  let to: string;
  try {
    from = parseStatementMonth(fromMonth);
    to = parseStatementMonth(toMonth);
  } catch {
    throw new CdrDeletionError('VALIDATION_ERROR', '月份格式应为 YYYY-MM');
  }
  if (from > to)
    throw new CdrDeletionError('VALIDATION_ERROR', '开始月份晚于结束月份');
  const months: string[] = [];
  for (let month = from; month <= to; month = addMonths(month, 1)) {
    months.push(month);
    if (months.length > CDR_DELETE_MAX_MONTHS)
      throw new CdrDeletionError(
        'VALIDATION_ERROR',
        `一次最多删除 ${CDR_DELETE_MAX_MONTHS} 个月`,
      );
  }
  return months;
}

function lastDayOf(month: string): string {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const day = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month.slice(0, 7)}-${String(day).padStart(2, '0')}`;
}

const stateText: Record<string, string> = {
  deleted: '话单已删除',
  no_statement: '没有已出账的账单（当前月或账单未生成）',
  before_opening: '早于租户开户月',
  future: '晚于当前月',
  blocked: '核对未通过或有话单尚未扣费',
};

/**
 * 删除一个租户若干整月的话单（阶段 8 决定 14、15、44、34、38、39）：
 * 1. tenantCode 必须与数据库里的编码完全相等；
 * 2. 先在只读事务里对所有月份做资格检查，任一月份不是 deletable 就整个请求拒绝，一条都不删；
 * 3. expectedCount 与各月话单条数之和不符：拒绝（预览之后又有话单进来、或另一管理员已删）；
 * 4. 按月升序、每月一个事务：租户锁 → 锁内重新检查资格与条数 → 删 cdrs → 置账单的 details_deleted 与
 *    删除元数据 → 写操作日志 cdr_delete。三步同事务，不会出现「话单没了而标志没置」或相反的状态。
 *    月份之间不原子（一个月可能几十万行，不能一个事务长时间持租户锁）：中途失败时已完成的月份保留，
 *    结果里列出已删与未删的月份，重试只处理剩余月份。
 * 只删 cdrs：流水、余额、账单头部与明细、call_uuids 都不动；raw_cdrs 的原始 JSON 也不随删除清除（决定 34）。
 * 第一个月就失败（没有任何月份被删）时直接抛出该错误。
 */
export async function deleteCdrMonths(
  db: Db,
  input: DeleteCdrMonthsInput,
): Promise<DeleteCdrMonthsResult> {
  const months = expandMonths(input.fromMonth, input.toMonth);

  // 快照读：账单行的标志与话单条数取自同一时刻，不会一半看到另一个管理员刚提交的删除。
  const { tenant, planned } = await withAdmin(
    db,
    async (tx) => {
      const tenant = await loadDeletionTenant(tx, input.tenantId);
      if (input.tenantCode !== tenant.code)
        throw new CdrDeletionError('VALIDATION_ERROR', '租户编码不符');
      const states = await readCdrDeletionMonths(tx, tenant, months);
      for (const state of states)
        if (state.state !== 'deletable')
          throw new CdrDeletionError(
            'CDR_MONTH_NOT_DELETABLE',
            `${state.month} 不可删除：${stateText[state.state] ?? state.state}`,
            state.month,
          );
      const planned = new Map(
        states.map((state) => [state.month, state.cdrCount ?? 0]),
      );
      let sum = 0;
      for (const count of planned.values()) sum += count;
      if (sum !== input.expectedCount)
        throw new CdrDeletionError(
          'CDR_DELETE_COUNT_CHANGED',
          `话单条数与预览不符（预览 ${input.expectedCount}，现在 ${sum}），请重新预览`,
        );
      return { tenant, planned };
    },
    { isolationLevel: 'repeatable read' },
  );

  const done: DeletedMonth[] = [];
  let rowsDeleted = 0;
  for (const [index, month] of months.entries()) {
    const key = monthKey(month);
    try {
      const result = await withAdmin(db, (tx) =>
        deleteOneMonth(tx, tenant, month, planned.get(key) ?? 0, input),
      );
      done.push(result);
      rowsDeleted += result.deleted;
    } catch (error) {
      if (done.length === 0) throw error;
      return {
        months: done,
        total: rowsDeleted,
        remaining: months.slice(index).map(monthKey),
        failure: {
          month: key,
          code: error instanceof CdrDeletionError ? error.code : 'INTERNAL',
          message: error instanceof Error ? error.message : String(error),
          error,
        },
      };
    }
  }
  return { months: done, total: rowsDeleted, remaining: [], failure: null };
}

async function deleteOneMonth(
  tx: Tx,
  tenant: DeletionTenant,
  month: string,
  plannedCount: number,
  input: DeleteCdrMonthsInput,
): Promise<DeletedMonth> {
  const key = monthKey(month);
  // 删除、入库、扣费、分配共用租户锁：持锁期间新话单排队，不会插进正在删除的月份。
  await lockTenants(tx, [tenant.id]);
  const [state] = await readCdrDeletionMonths(tx, tenant, [month]);
  if (!state || state.state !== 'deletable')
    throw new CdrDeletionError(
      'CDR_MONTH_NOT_DELETABLE',
      `${key} 不可删除：${stateText[state?.state ?? ''] ?? '状态未知'}`,
      key,
    );
  if ((state.cdrCount ?? 0) !== plannedCount)
    throw new CdrDeletionError(
      'CDR_DELETE_COUNT_CHANGED',
      `${key} 的话单条数与预览不符（预览 ${plannedCount}，现在 ${state.cdrCount ?? 0}），请重新预览`,
      key,
    );

  const { lo, hi } = monthRange(month);
  const { rows } = await tx.execute<{ deleted: number }>(sql`
    with gone as (
      delete from cdrs c
      where c.tenant_id = ${tenant.id}::uuid
        and coalesce(c.answered_at, c.started_at) >= ${lo}
        and coalesce(c.answered_at, c.started_at) < ${hi}
        and c.started_at >= ${lo} - interval '31 days'
        and c.started_at < ${hi}
      returning 1)
    select count(*)::int as deleted from gone`);
  const deleted = rows[0]?.deleted ?? 0;
  if (deleted !== plannedCount)
    throw new Error(
      `${key} 实际删除 ${deleted} 条，与锁内统计的 ${plannedCount} 条不符`,
    );

  const [statement] = await tx
    .update(monthlyStatements)
    .set({
      detailsDeleted: true,
      detailsDeletedAt: sql`clock_timestamp()`,
      detailsDeletedBy: input.actor.id,
      detailsDeletedCount: deleted,
    })
    .where(
      and(
        eq(monthlyStatements.tenantId, tenant.id),
        eq(monthlyStatements.month, month),
        eq(monthlyStatements.detailsDeleted, false),
      ),
    )
    .returning({
      id: monthlyStatements.id,
      deletedAt: monthlyStatements.detailsDeletedAt,
    });
  if (!statement?.deletedAt)
    throw new Error(`${key} 的账单没有置上话单已删除标志`);

  // 展示用的时间范围：开户当月从开户日起；开户日不在这个月里（回填的历史流水）时取整月。
  const createdDay = beijingDay(tenant.createdAt);
  const to = lastDayOf(month);
  const from = createdDay > month && createdDay <= to ? createdDay : month;
  const auditId = randomUUID();
  await writeAudit(tx, {
    id: auditId,
    actor: input.actor,
    occurredAt: statement.deletedAt.toISOString(),
    tenantId: tenant.id,
    target: { kind: 'statement', id: statement.id },
    action: 'cdr_delete',
    content: {
      summary: `删除话单 ${tenant.code} ${month.slice(0, 4)}年${Number(month.slice(5, 7))}月 ${deleted.toLocaleString('en-US')} 条；原始 JSON 不随删除话单清除，按归档策略老化`,
      changes: [{ field: 'callCount', before: String(deleted), after: '0' }],
      month: key,
      deletedCount: deleted,
      range: { from, to },
      confirmedCode: input.tenantCode,
    },
  });
  return { month: key, deleted, statementId: statement.id, auditId };
}
