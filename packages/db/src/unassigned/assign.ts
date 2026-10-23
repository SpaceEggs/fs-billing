import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  beijingMonth,
  beijingTime,
  decimal,
  type Currency,
} from '@fs-billing/rating';
import type { AuditPayload } from '@fs-billing/shared';
import { writeAudit } from '../admin/audit.js';
import {
  chargeCall,
  loadDeletedMonths,
  priceAndInsertCdr,
} from '../cdr-intake.js';
import { lockTenants, withAdmin, type PoolDb } from '../client.js';
import { ensureCdrPartitions } from '../partitions.js';
import {
  tenantBalances,
  tenants,
  unassignedAssignments,
  unassignedCdrs,
} from '../schema.js';
import { databaseInstant } from '../statements/live.js';
import { monthKey } from '../statements/months.js';
import { classifyRows } from './classify.js';
import {
  affectedMonthStarts,
  describeAffectedMonths,
  loadAssignmentTarget,
  type AffectedMonth,
} from './preview.js';
import {
  ASSIGN_MAX_ROWS,
  UnassignedError,
  selectRows,
  selectionDigest,
  selectionTag,
  type UnassignedSelection,
} from './types.js';
import { NotFoundError } from '../errors.js';

export interface AssignInput {
  readonly actor: AuditPayload['actor'];
  readonly tenantId: string;
  readonly selection: UnassignedSelection;
  /** 客户端幂等键，同一租户内唯一。 */
  readonly idempotencyKey: string;
  /** 预览时看到的数字；事务内实算不符则整个事务回滚。 */
  readonly expected: {
    readonly assignable: number;
    readonly noRate: number;
    readonly chargeTotal: string;
  };
  readonly maxRows?: number;
}

export interface AssignResult {
  readonly assignmentId: string;
  readonly auditId: string;
  /** 同键重放：返回原批次的结果，没有再次执行。 */
  readonly replayed: boolean;
  readonly tenantId: string;
  readonly currency: Currency;
  readonly assigned: number;
  readonly noRate: number;
  readonly blocked: number;
  readonly chargeTotal: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly affectedMonths: readonly AffectedMonth[];
}

const SYMBOL: Record<Currency, string> = { CNY: '¥', USD: '$' };

/**
 * 分配之前，另起事务为选中话单的开始月份建好 cdrs 分区。cdrs 的分区只由维护任务建，
 * 而未归属话单可能比现有分区更老；建分区不能在持租户锁的事务里（持锁时数据库拒绝），所以要在前面。
 */
async function ensurePartitionsFor(
  db: PoolDb,
  selection: UnassignedSelection,
  maxRows: number,
): Promise<void> {
  const months = await withAdmin(db, async (tx) => {
    const rows = await selectRows(tx, selection, {
      status: 'pending',
      lock: false,
      maxRows,
    });
    return [
      ...new Set(
        rows.flatMap((row) =>
          row.callUuid !== null && row.startedAt !== null
            ? [beijingMonth(row.startedAt)]
            : [],
        ),
      ),
    ].sort();
  });
  for (const month of months)
    await ensureCdrPartitions(db, {
      moment: beijingTime(`${month}-01 00:00:00`),
      monthsAhead: 0,
    });
}

/**
 * 把选中的待处理话单分配给租户并补扣费，一个事务（决定 2、3、4）：
 * 1. 租户锁（先于任何写入与行锁）；2. 同键重放返回原结果；3. 行锁取待处理行（FOR UPDATE，
 * 并发的另一个请求等待后重判 status，已分配的行不再出现）；4. 在锁内重算：与 expected 不符整体回滚；
 * 5. 逐条 priceAndInsertCdr（认领 call_uuids）与 chargeCall（call_charge 流水，幂等键 call:<UUID>）；
 * 6. 批次、话单状态、操作日志同事务写入。无费率、月份冻结、不可分配的行不动，保持 pending。
 * 任何一步失败整个事务回滚：没有「已扣费未入库」的状态。
 */
export async function assignUnassigned(
  db: PoolDb,
  input: AssignInput,
): Promise<AssignResult> {
  const key = input.idempotencyKey.trim();
  if (key === '')
    throw new UnassignedError('VALIDATION_ERROR', '幂等键不能为空');
  const maxRows = input.maxRows ?? ASSIGN_MAX_ROWS;
  const expectedTotal = decimal(input.expected.chargeTotal);
  const digest = selectionDigest(input.selection, {
    tenantId: input.tenantId,
    assignable: input.expected.assignable,
    noRate: input.expected.noRate,
    chargeTotal: expectedTotal.toFixed(),
  });

  await ensurePartitionsFor(db, input.selection, maxRows);

  return withAdmin(db, async (tx) => {
    await lockTenants(tx, [input.tenantId]);

    const [existing] = await tx
      .select()
      .from(unassignedAssignments)
      .where(
        and(
          eq(unassignedAssignments.tenantId, input.tenantId),
          eq(unassignedAssignments.idempotencyKey, key),
        ),
      );
    if (existing) {
      if (
        existing.requestedBy.toLowerCase() !== input.actor.id.toLowerCase() ||
        existing.requestDigest !== digest
      )
        throw new UnassignedError(
          'IDEMPOTENCY_CONFLICT',
          '幂等键已用于另一个操作人或另一份选择',
        );
      const [tenant] = await tx
        .select({ currency: tenants.currency })
        .from(tenants)
        .where(eq(tenants.id, existing.tenantId));
      if (!tenant) throw new NotFoundError('租户不存在');
      return {
        assignmentId: existing.id,
        auditId: existing.auditId,
        replayed: true,
        tenantId: existing.tenantId,
        currency: tenant.currency,
        assigned: existing.assignedCount,
        noRate: existing.noRateCount,
        blocked: existing.blockedCount,
        chargeTotal: decimal(existing.chargeTotal).toFixed(),
        balanceBefore: decimal(existing.balanceBefore).toFixed(),
        balanceAfter: decimal(existing.balanceAfter).toFixed(),
        affectedMonths: await describeAffectedMonths(
          tx,
          existing.tenantId,
          existing.affectedMonths,
        ),
      } satisfies AssignResult;
    }

    const target = await loadAssignmentTarget(tx, input.tenantId);
    const rows = await selectRows(tx, input.selection, {
      status: 'pending',
      lock: true,
      maxRows,
    });
    // 删除话单持同一把租户锁，所以锁内读到的 details_deleted 就是最新已提交的（决定 38）。
    const deletedMonths = await loadDeletedMonths(tx, target.id);
    const classification = classifyRows(rows, target, deletedMonths);
    const { assignable } = classification;

    if (assignable.length === 0)
      throw new UnassignedError(
        'UNASSIGNED_NOTHING_TO_ASSIGN',
        '选择中没有可分配的待处理话单',
      );
    if (
      assignable.length !== input.expected.assignable ||
      classification.noRate.length !== input.expected.noRate ||
      !classification.chargeTotal.eq(expectedTotal)
    )
      throw new UnassignedError(
        'UNASSIGNED_PREVIEW_STALE',
        '预览之后数据已变化，请重新预览',
      );

    const balanceBefore = decimal(target.balance);
    for (const item of assignable) {
      const inserted = await priceAndInsertCdr(
        tx,
        target,
        item.cdr,
        item.billingNumber,
        { deletedMonths },
      );
      if (inserted.status !== 'inserted')
        throw new Error(
          `话单 ${item.cdr.callUuid} 在租户锁内重算后不可分配（${inserted.status}）`,
        );
      const charged = await chargeCall(
        tx,
        { tenantId: target.id, callUuid: item.cdr.callUuid },
        { deletedMonths },
      );
      if (!decimal(charged.charge).eq(inserted.charge))
        throw new Error(`话单 ${item.cdr.callUuid} 的扣费金额与定价不一致`);
    }

    const [balance] = await tx
      .select({ balance: tenantBalances.balance })
      .from(tenantBalances)
      .where(eq(tenantBalances.tenantId, target.id));
    if (!balance) throw new Error('租户余额行缺失');
    const balanceAfter = decimal(balance.balance);
    if (!balanceAfter.eq(balanceBefore.minus(classification.chargeTotal)))
      throw new Error('分配后余额与扣费合计不符');

    const months = affectedMonthStarts(classification);
    const assignmentId = randomUUID();
    const auditId = randomUUID();
    const sourceTag = selectionTag(input.selection);
    const chargeTotal = classification.chargeTotal.toFixed();
    await tx.insert(unassignedAssignments).values({
      id: assignmentId,
      tenantId: target.id,
      idempotencyKey: key,
      requestedBy: input.actor.id,
      sourceTag,
      requestDigest: digest,
      assignedCount: assignable.length,
      noRateCount: classification.noRate.length,
      blockedCount: classification.blocked.length,
      chargeTotal,
      balanceBefore: balanceBefore.toFixed(),
      balanceAfter: balanceAfter.toFixed(),
      affectedMonths: months,
      auditId,
    });
    const updated = await tx
      .update(unassignedCdrs)
      .set({
        status: 'assigned',
        assignedTenantId: target.id,
        resolvedBy: input.actor.id,
        resolvedAt: sql`now()`,
        assignmentId,
      })
      .where(
        and(
          eq(unassignedCdrs.status, 'pending'),
          inArray(
            unassignedCdrs.id,
            assignable.map((item) => item.row.id),
          ),
        ),
      )
      .returning({ id: unassignedCdrs.id });
    if (updated.length !== assignable.length)
      throw new Error('分配时有待处理话单被其他操作改动');

    const symbol = SYMBOL[target.currency];
    await writeAudit(tx, {
      id: auditId,
      actor: input.actor,
      occurredAt: (await databaseInstant(tx)).toISOString(),
      tenantId: target.id,
      target: { kind: 'unassigned_batch', id: assignmentId },
      action: 'unassigned_assign',
      content: {
        summary: `${sourceTag === null ? '' : `从标签 ${sourceTag === '' ? '（空）' : sourceTag} `}归属到 ${target.code} ${assignable.length} 条，扣费 ${symbol}${chargeTotal}${
          classification.noRate.length > 0
            ? `；${classification.noRate.length} 条匹配不到费率未归属`
            : ''
        }`,
        changes: [
          {
            field: 'callCount',
            before: null,
            after: String(assignable.length),
          },
          { field: 'amount', before: null, after: chargeTotal },
          {
            field: 'balance',
            before: balanceBefore.toFixed(),
            after: balanceAfter.toFixed(),
          },
        ],
        sourceTag,
        assignedCount: assignable.length,
        noRateCount: classification.noRate.length,
        blockedCount: classification.blocked.length,
        chargeTotal,
        currency: target.currency,
        affectedMonths: months.map(monthKey),
      },
    });

    return {
      assignmentId,
      auditId,
      replayed: false,
      tenantId: target.id,
      currency: target.currency,
      assigned: assignable.length,
      noRate: classification.noRate.length,
      blocked: classification.blocked.length,
      chargeTotal,
      balanceBefore: balanceBefore.toFixed(),
      balanceAfter: balanceAfter.toFixed(),
      affectedMonths: await describeAffectedMonths(tx, target.id, months),
    } satisfies AssignResult;
  });
}
