import { createHash } from 'node:crypto';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import type { Tx } from '../client.js';
import { unassignedCdrs, type UnassignedCdrStatus } from '../schema.js';

/** 单次分配 / 选择的行数上限默认值（阶段 8 决定 5，以 PORTALBIG 实测为准，见 docs/evidence/phase-8）。 */
export const ASSIGN_MAX_ROWS = 2000;

/** 可分配的未归属原因（决定 35）：其余原因只能忽略。 */
export const ASSIGNABLE_REASONS: readonly string[] = [
  '租户不存在',
  '缺少租户标签',
  '接通时无费率',
];

export type UnassignedErrorCode =
  | 'UNASSIGNED_PREVIEW_STALE'
  | 'UNASSIGNED_NOTHING_TO_ASSIGN'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VALIDATION_ERROR';

/** 未归属话单操作的业务拒绝；API 层映射成 409 / 400。 */
export class UnassignedError extends Error {
  constructor(
    readonly code: UnassignedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UnassignedError';
  }
}

/** 勾选的 id（上限见 maxRows），或「选择该分组全部」：标签空串表示标签为空的分组。 */
export type UnassignedSelection =
  | { readonly ids: readonly string[] }
  | { readonly group: { readonly tag: string } };

export function selectionTag(selection: UnassignedSelection): string | null {
  return 'group' in selection ? selection.group.tag : null;
}

/** 选择的稳定摘要：id 去重排序，用于幂等重放时核对是同一份选择。 */
export function selectionDigest(
  selection: UnassignedSelection,
  extra: unknown = null,
): string {
  const normalized =
    'group' in selection
      ? { group: selection.group.tag }
      : {
          ids: [...new Set(selection.ids.map((id) => id.toLowerCase()))].sort(),
        };
  return createHash('sha256')
    .update(JSON.stringify({ selection: normalized, extra }))
    .digest('hex');
}

function selectionPredicate(
  selection: UnassignedSelection,
  maxRows: number,
): SQL {
  if ('group' in selection) {
    return eq(unassignedCdrs.tenantTag, selection.group.tag);
  }
  const ids = [...new Set(selection.ids.map((id) => id.toLowerCase()))];
  if (ids.length === 0)
    throw new UnassignedError('VALIDATION_ERROR', '没有选择任何话单');
  if (ids.length > maxRows)
    throw new UnassignedError(
      'VALIDATION_ERROR',
      `一次最多选择 ${maxRows} 条，请分批处理`,
    );
  return inArray(unassignedCdrs.id, ids);
}

const rowColumns = {
  id: unassignedCdrs.id,
  tenantTag: unassignedCdrs.tenantTag,
  callUuid: unassignedCdrs.callUuid,
  reason: unassignedCdrs.reason,
  startedAt: unassignedCdrs.startedAt,
  answeredAt: unassignedCdrs.answeredAt,
  endedAt: unassignedCdrs.endedAt,
  caller: unassignedCdrs.caller,
  callee: unassignedCdrs.callee,
  billingNumber: unassignedCdrs.billingNumber,
  durationSeconds: unassignedCdrs.durationSeconds,
  hangupCause: unassignedCdrs.hangupCause,
  unverified: unassignedCdrs.unverified,
  receivedAt: unassignedCdrs.receivedAt,
};
export type SelectedRow = Pick<
  typeof unassignedCdrs.$inferSelect,
  keyof typeof rowColumns
>;

/**
 * 选中的、处于 status 的行，按 (started_at, id) 排序。
 * lock 为真时加 FOR UPDATE：并发的另一个请求在行锁上等待，提交后重新判断 status，已处理的行不再出现。
 * 分配与忽略共用这个顺序，所以两个事务锁行的顺序一致，不会互相死锁。
 * 超过 maxRows 抛 VALIDATION_ERROR（多取一行用来判断）。
 */
export async function selectRows(
  tx: Tx,
  selection: UnassignedSelection,
  options: { status: UnassignedCdrStatus; lock: boolean; maxRows: number },
): Promise<SelectedRow[]> {
  const query = tx
    .select(rowColumns)
    .from(unassignedCdrs)
    .where(
      and(
        eq(unassignedCdrs.status, options.status),
        selectionPredicate(selection, options.maxRows),
      ),
    )
    .orderBy(unassignedCdrs.startedAt, unassignedCdrs.id)
    .limit(options.maxRows + 1);
  const rows = await (options.lock ? query.for('update') : query);
  if (rows.length > options.maxRows)
    throw new UnassignedError(
      'VALIDATION_ERROR',
      `一次最多处理 ${options.maxRows} 条，请分批处理`,
    );
  return rows;
}
