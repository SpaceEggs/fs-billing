import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import type { AuditActor } from '@fs-billing/shared';
import { writeAudit } from '../admin/audit.js';
import { recoverClearedUnassignedAlerts } from '../alerts.js';
import { withAdmin, type Db, type Tx } from '../client.js';
import { unassignedCdrs } from '../schema.js';
import { databaseInstant } from '../statements/live.js';
import {
  IGNORE_MAX_ROWS,
  UnassignedError,
  selectRows,
  selectionTag,
  type UnassignedSelection,
} from './types.js';

export interface IgnoreResult {
  /** 实际改变状态的话单条数；重复提交时为 0，此时不写日志。 */
  readonly changed: number;
  readonly auditId: string | null;
}

const MAX_REASON_LENGTH = 2000;

/**
 * 忽略：pending → ignored，必填原因，写操作日志 unassigned_ignore（同事务）。
 * 行锁与分配一致（FOR UPDATE，同一排序），所以与并发的分配不会互相死锁，被分配走的行不会被忽略。
 * 没有 call_uuid 的校验失败行、无费率行都可以忽略；已分配的行不在 pending，不受影响。
 * 影响 0 行时返回 changed: 0，不写日志（重复提交幂等）。
 * 某个原因的待处理行因此清零时，同键的系统告警一并恢复。
 */
export async function ignoreUnassigned(
  db: Db | Tx,
  input: {
    readonly actor: AuditActor;
    readonly selection: UnassignedSelection;
    readonly reason: string;
    readonly maxRows?: number;
  },
): Promise<IgnoreResult> {
  const reason = input.reason.trim();
  if (reason === '')
    throw new UnassignedError('VALIDATION_ERROR', '忽略必须填写原因');
  if (reason.length > MAX_REASON_LENGTH)
    throw new UnassignedError(
      'VALIDATION_ERROR',
      `忽略原因不能超过 ${MAX_REASON_LENGTH} 个字`,
    );
  return withAdmin(db, async (tx) => {
    const rows = await selectRows(tx, input.selection, {
      status: 'pending',
      lock: true,
      maxRows: input.maxRows ?? IGNORE_MAX_ROWS,
    });
    if (rows.length === 0) return { changed: 0, auditId: null };
    await tx
      .update(unassignedCdrs)
      .set({
        status: 'ignored',
        ignoreReason: reason,
        resolvedBy: input.actor.id,
        resolvedAt: sql`now()`,
      })
      .where(
        inArray(
          unassignedCdrs.id,
          rows.map((row) => row.id),
        ),
      );
    // 同键的待处理行清零，对应的系统告警恢复（阶段 9）。
    await recoverClearedUnassignedAlerts(tx, rows);
    const auditId = randomUUID();
    const sourceTag = selectionTag(input.selection);
    await writeAudit(tx, {
      id: auditId,
      actor: input.actor,
      occurredAt: (await databaseInstant(tx)).toISOString(),
      tenantId: null,
      // 忽略没有批次表：对象取本条审计自身的 id。
      target: { kind: 'unassigned_batch', id: auditId },
      action: 'unassigned_ignore',
      content: {
        summary: `忽略 ${rows.length} 条未归属话单：${reason}`,
        changes: [
          { field: 'callCount', before: null, after: String(rows.length) },
        ],
        count: rows.length,
        reason,
        sourceTag,
      },
    });
    return { changed: rows.length, auditId };
  });
}

/** 撤销忽略：ignored → pending，清空忽略字段，写操作日志 unassigned_unignore。 */
export function unignoreUnassigned(
  db: Db | Tx,
  input: {
    readonly actor: AuditActor;
    readonly selection: UnassignedSelection;
    readonly maxRows?: number;
  },
): Promise<IgnoreResult> {
  return withAdmin(db, async (tx) => {
    const rows = await selectRows(tx, input.selection, {
      status: 'ignored',
      lock: true,
      maxRows: input.maxRows ?? IGNORE_MAX_ROWS,
    });
    if (rows.length === 0) return { changed: 0, auditId: null };
    await tx
      .update(unassignedCdrs)
      .set({
        status: 'pending',
        ignoreReason: null,
        resolvedBy: null,
        resolvedAt: null,
      })
      .where(
        inArray(
          unassignedCdrs.id,
          rows.map((row) => row.id),
        ),
      );
    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor: input.actor,
      occurredAt: (await databaseInstant(tx)).toISOString(),
      tenantId: null,
      target: { kind: 'unassigned_batch', id: auditId },
      action: 'unassigned_unignore',
      content: {
        summary: `撤销忽略 ${rows.length} 条未归属话单`,
        changes: [
          { field: 'callCount', before: null, after: String(rows.length) },
        ],
        count: rows.length,
      },
    });
    return { changed: rows.length, auditId };
  });
}
