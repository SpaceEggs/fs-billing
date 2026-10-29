import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { CDR_VALIDATION_FAILURE_PREFIX } from '@fs-billing/shared';
import type { Tx } from './client.js';
import {
  systemAlerts,
  unassignedCdrs,
  type SystemAlertKind,
} from './schema.js';

/**
 * 系统告警的统一写入与恢复（阶段 9 设计「告警模型」）。告警靠结构化的 (kind, subject_key) 识别：
 * 同一个身份同时只有一条未恢复，再次发生是在这一条上累加事件，而不是新开一行或按描述前缀去找。
 * 事件时间取数据库处理时间（默认 now()），不取话单时间；测试可传 `at` 推进时钟。
 */

/** 事件型告警的静默恢复窗口默认值（分钟）；Worker 配置 `ALERT_QUIET_MINUTES` 覆盖（PR 2）。 */
export const DEFAULT_ALERT_QUIET_MINUTES = 10;

const UNASSIGNED_PREFIX = 'unassigned:';
const INVALID_CDR_PREFIX = 'invalid-cdr:';
/** 与 apps/worker 入库停放的原因文本一致（也在 ASSIGNABLE_REASONS 里）。 */
const TENANT_MISSING_REASON = '租户不存在';

/** 各写入点的键。固定键直接写字符串；带参数的由这里的函数拼，写入与恢复两边用同一个。 */
export const AlertKeys = {
  /** 未验证话单入库（FreeSWITCH 授权超时放行），全局一条。 */
  authTimeout: 'fs-authorize',
  /** JSON 语法损坏的推送，全局一条（没有 UUID，也没有待处理行）。 */
  invalidJson: 'invalid-json',
  /** HTTP 503：话单保存失败。 */
  cdrSave: 'cdr-save',
  /** 入库路径缺分区（23514）。 */
  partitionMissing: 'partition-missing',
  /** 分区维护任务失败。 */
  partitionMaintenance: 'partition-maintenance',
  /** 重置密码的审计写入失败。 */
  auditResetPassword: 'audit:reset-password',
  chargeReconcile: (callUuid: string) => `charge-reconcile:${callUuid}`,
  statement: (tenantId: string, month: string) =>
    `statement:${tenantId}:${month}`,
  archive: (month: string) => `archive:${month}`,
  /** 停放到未归属：按原因合并；租户不存在时再按租户标签分。 */
  unassigned: (reason: string, tenantTag: string) =>
    reason === TENANT_MISSING_REASON
      ? `${UNASSIGNED_PREFIX}${reason}:${tenantTag}`
      : `${UNASSIGNED_PREFIX}${reason}`,
  /** 话单校验失败：按阶段 8 的结构化原因（含固定前缀，≤ 200 字符）合并。 */
  invalidCdr: (reason: string) => `${INVALID_CDR_PREFIX}${reason}`,
} as const;

/**
 * 新告警是否发邮件，按 kind 与子类型（决定 32）：`email_failed` 恒为假——发邮件的通道坏了，
 * 再用它发邮件没有意义，也避免循环；其余为真。只在新开时定下，之后改策略不回头影响旧告警。
 */
export function alertNotifies(kind: SystemAlertKind): boolean {
  return kind !== 'email_failed';
}

export interface RaiseAlertInput {
  readonly kind: SystemAlertKind;
  readonly subjectKey: string;
  /**
   * 新开时记录；合并到已有告警时保持原值。只有按租户分的键（`charge-reconcile:*`、`statement:*`，
   * 以后的 `recipient:*`）带租户；全局键（`fs-authorize`、`invalid-json`、`cdr-save`、`partition-*`、
   * `audit:reset-password`、`unassigned:*`、`invalid-cdr:*`、`archive:*`）不传，租户为空——
   * 合并了多个租户的事件之后，保留第一次事件的租户没有意义。
   */
  readonly tenantId?: string | null | undefined;
  /** 总是覆盖为最近一次事件的描述。 */
  readonly description: string;
  /** 本次事件影响的通话数，默认 0。 */
  readonly calls?: number | undefined;
  /** `add`（默认）累加到 affected_calls；`set` 覆盖，用于账单核对这类「当前状态」的告警。 */
  readonly callsMode?: 'add' | 'set' | undefined;
  /** 事件时间；默认数据库 now()。 */
  readonly at?: Date | undefined;
}

/**
 * 开一条告警，或在同一 (kind, subject_key) 已有未恢复的告警上累加：occurrences + 1、更新最近事件时间与描述。
 * 并发的两个事件由局部唯一索引加 ON CONFLICT 合并成一条。
 */
export async function raiseAlert(
  tx: Tx,
  input: RaiseAlertInput,
): Promise<{ id: string; opened: boolean }> {
  const calls = input.calls ?? 0;
  const at = input.at ?? sql`now()`;
  const [row] = await tx
    .insert(systemAlerts)
    .values({
      kind: input.kind,
      subjectKey: input.subjectKey,
      tenantId: input.tenantId ?? null,
      description: input.description,
      affectedCalls: calls,
      startedAt: input.at ?? sql`now()`,
      lastSeenAt: at,
      notify: alertNotifies(input.kind),
    })
    .onConflictDoUpdate({
      target: [systemAlerts.kind, systemAlerts.subjectKey],
      targetWhere: sql`recovered_at IS NULL AND subject_key IS NOT NULL`,
      set: {
        occurrences: sql`${systemAlerts.occurrences} + 1`,
        affectedCalls:
          input.callsMode === 'set'
            ? calls
            : sql`${systemAlerts.affectedCalls} + ${calls}`,
        lastSeenAt: at,
        description: input.description,
      },
    })
    .returning({ id: systemAlerts.id, opened: sql<boolean>`(xmax = 0)` });
  return { id: row!.id, opened: row!.opened };
}

/** recovered_at 不能早于 started_at（表约束）；测试推进时钟时取较大者。 */
const recoveredAtValue = (at: Date | undefined) =>
  sql`greatest(${systemAlerts.startedAt}, ${at ?? sql`now()`})`;

/** 恢复一个身份下未恢复的告警；已恢复的不动。返回恢复的条数（0 或 1）。 */
export async function recoverAlert(
  tx: Tx,
  input: {
    readonly kind: SystemAlertKind;
    readonly subjectKey: string;
    readonly at?: Date | undefined;
  },
): Promise<number> {
  return recoverAlertsWhere(
    tx,
    and(
      eq(systemAlerts.kind, input.kind),
      eq(systemAlerts.subjectKey, input.subjectKey),
    )!,
    input.at,
  );
}

/** 恢复满足条件的未恢复告警。条件由调用方写，已恢复的行永远不动。 */
export async function recoverAlertsWhere(
  tx: Tx,
  condition: SQL,
  at?: Date,
): Promise<number> {
  const recovered = await tx
    .update(systemAlerts)
    .set({ recoveredAt: recoveredAtValue(at) })
    .where(and(isNull(systemAlerts.recoveredAt), condition))
    .returning({ id: systemAlerts.id });
  return recovered.length;
}

/**
 * 事件型告警：没有「修正」可对，靠静默窗口恢复（决定 35）。其余键由各自的条件恢复。
 * `partition-missing` 也在这里，不能随分区维护成功恢复：维护只建当月和下一个月，缺的若是被归档分离的旧月或更远的
 * 将来月份，维护照常成功而入库继续 23514，恢复后下一条话单又重开，会成为开/恢复的往返（PR 4 起每次都发邮件）。
 */
const QUIET_WINDOW_ALERTS: readonly {
  kind: SystemAlertKind;
  subjectKey: string;
}[] = [
  { kind: 'auth_timeout', subjectKey: AlertKeys.authTimeout },
  { kind: 'cdr_failed', subjectKey: AlertKeys.invalidJson },
  { kind: 'cdr_failed', subjectKey: AlertKeys.cdrSave },
  { kind: 'audit_failed', subjectKey: AlertKeys.auditResetPassword },
  { kind: 'partition_failed', subjectKey: AlertKeys.partitionMissing },
];

/**
 * 静默窗口恢复：事件型告警在 `quietMinutes` 分钟内没有新事件即恢复，之后再出现事件开新的一条。
 * 由 Worker 的定时任务调用（PR 4 的 notify-tick）；`at` 默认数据库时间。
 */
export async function recoverQuietAlerts(
  tx: Tx,
  options: { quietMinutes?: number; at?: Date } = {},
): Promise<number> {
  const quietMinutes = options.quietMinutes ?? DEFAULT_ALERT_QUIET_MINUTES;
  const now = options.at ?? sql`now()`;
  return recoverAlertsWhere(
    tx,
    and(
      sql`${systemAlerts.lastSeenAt} <= ${now}::timestamptz - ${quietMinutes} * interval '1 minute'`,
      sql`(${systemAlerts.kind}, ${systemAlerts.subjectKey}) IN (${sql.join(
        QUIET_WINDOW_ALERTS.map(
          (entry) => sql`(${entry.kind}, ${entry.subjectKey})`,
        ),
        sql`, `,
      )})`,
    )!,
    options.at,
  );
}

/**
 * 未归属 / 校验失败这一族告警（`unassigned:*`、`invalid-cdr:*`）的事务级互斥。
 * 入库停放与修正稿、忽略、分配、恢复扫描都改这一族告警，又互相锁待处理行和告警行，各自按不同顺序会成环
 * （告警行的 id 是随机 UUID，`ORDER BY id` 也不能让两条路径的加锁顺序一致）。所以所有这些路径先拿同一把锁，
 * 再碰任何待处理行或告警行；正常入库（入队扣费）不拿。
 *
 * 应用角色不能直接调 pg_advisory_*（迁移 0000 撤销），经 SECURITY DEFINER 的 lock_alert_family()。
 * 顺序约定：先 `lockTenants`（它要求事务里还没有别的锁），再拿这把锁；入库之外的路径里它先于待处理行的 FOR UPDATE。
 */
export async function lockUnassignedAlerts(tx: Tx): Promise<void> {
  await tx.execute(sql`select lock_alert_family()`);
}

/** 一条未归属话单对应的告警键。校验失败行没有 call_uuid，原因带固定前缀。 */
export function unassignedRowAlertKey(row: {
  readonly callUuid: string | null;
  readonly reason: string;
  readonly tenantTag: string;
}): string {
  return row.callUuid === null &&
    row.reason.startsWith(CDR_VALIDATION_FAILURE_PREFIX)
    ? AlertKeys.invalidCdr(row.reason)
    : AlertKeys.unassigned(row.reason, row.tenantTag);
}

/** 告警键反推「待处理行」的条件：同键的 pending 行清零才算恢复。 */
function pendingRowsOfKey(key: string): SQL | undefined {
  if (key.startsWith(INVALID_CDR_PREFIX))
    return and(
      isNull(unassignedCdrs.callUuid),
      eq(unassignedCdrs.reason, key.slice(INVALID_CDR_PREFIX.length)),
    );
  if (key.startsWith(UNASSIGNED_PREFIX)) {
    const rest = key.slice(UNASSIGNED_PREFIX.length);
    const tagged = `${TENANT_MISSING_REASON}:`;
    return rest.startsWith(tagged)
      ? and(
          eq(unassignedCdrs.reason, TENANT_MISSING_REASON),
          eq(unassignedCdrs.tenantTag, rest.slice(tagged.length)),
        )
      : eq(unassignedCdrs.reason, rest);
  }
  return undefined;
}

/**
 * 同键的 pending 未归属行清零（分配、忽略、修正稿使旧行 superseded 都算）就恢复对应的告警。
 * `rows` 是刚离开 pending 的行时只检查它们的键（在同一事务里调用）；不传则检查全部进行中的未归属类告警（定时任务兜底）。
 *
 * 先拿这一族告警的互斥锁（lockUnassignedAlerts），再给告警行加锁、判断：并发入库的停放与校验失败路径也先拿同一把锁，
 * 所以不会出现「先判断没有待处理行、随后入库新插入待处理行并累加告警、再被恢复掉」。
 */
export async function recoverClearedUnassignedAlerts(
  tx: Tx,
  rows?: readonly {
    readonly callUuid: string | null;
    readonly reason: string;
    readonly tenantTag: string;
  }[],
): Promise<number> {
  const keys = rows ? [...new Set(rows.map(unassignedRowAlertKey))] : undefined;
  if (keys?.length === 0) return 0;
  await lockUnassignedAlerts(tx);
  const open = await tx
    .select({ id: systemAlerts.id, subjectKey: systemAlerts.subjectKey })
    .from(systemAlerts)
    .where(
      and(
        eq(systemAlerts.kind, 'cdr_failed'),
        isNull(systemAlerts.recoveredAt),
        keys
          ? inArray(systemAlerts.subjectKey, keys)
          : sql`(starts_with(${systemAlerts.subjectKey}, ${UNASSIGNED_PREFIX})
              OR starts_with(${systemAlerts.subjectKey}, ${INVALID_CDR_PREFIX}))`,
      ),
    )
    .orderBy(systemAlerts.id)
    .for('update');
  let recovered = 0;
  for (const alert of open) {
    const match = alert.subjectKey && pendingRowsOfKey(alert.subjectKey);
    if (!match) continue;
    const [pending] = await tx
      .select({ one: sql`1` })
      .from(unassignedCdrs)
      .where(and(eq(unassignedCdrs.status, 'pending'), match))
      .limit(1);
    if (pending) continue;
    recovered += await recoverAlertsWhere(tx, eq(systemAlerts.id, alert.id));
  }
  return recovered;
}

/**
 * 扣费对账告警兜底：该通话的 `call:<UUID>` 流水已存在（例如人工补记）就恢复。
 * 正常路径由 chargeCall 在写流水的同一事务里恢复；这个函数给定时任务扫一遍。
 */
export async function recoverPaidChargeReconcileAlerts(
  tx: Tx,
): Promise<number> {
  const prefix = AlertKeys.chargeReconcile('');
  return recoverAlertsWhere(
    tx,
    and(
      eq(systemAlerts.kind, 'cdr_failed'),
      sql`starts_with(${systemAlerts.subjectKey}, ${prefix})`,
      sql`EXISTS (SELECT 1 FROM ledger_entries l
        WHERE l.tenant_id = ${systemAlerts.tenantId} AND l.kind = 'call_charge'
          AND l.idempotency_key = 'call:' || substring(${systemAlerts.subjectKey} FROM ${prefix.length + 1}::int))`,
    )!,
  );
}
