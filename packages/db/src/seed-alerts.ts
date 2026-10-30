import { sql } from 'drizzle-orm';
import { systemAlerts, type SystemAlertKind } from './schema.js';
import type { Tx } from './client.js';
import { AlertKeys } from './alerts.js';
import { EmailAlertKeys } from './outbox.js';
import { seededUuid } from './seed-calls.js';

/**
 * 系统告警的开发种子（阶段 9 PR 8）：设计稿「管理后台 第三批 · 运营」概览与系统告警页的 5 条示例告警，
 * 写成现有代码真正会写出的形态（键、类型、描述措辞与各写入点一致）。
 *
 * 设计稿的第二条「话单推送延迟，队列积压 1,204 条」没有对应的检测（阶段 9 决定 36），改成同样落在「话单处理失败」
 * 类型下的真实形态：话单保存失败（HTTP 503）。设计稿第三条「邮件被退信、地址不存在」是 SMTP 同步拒收的形态
 * （RCPT TO 阶段 5xx，记在 `recipient:<租户>`），退信解析不在本阶段（设计「设计稿与文档的出入」第 3 条）。
 *
 * **种子写的是历史，不是事件：** 全部 `notify = false`，并像迁移 0020 的回填那样标记开始已通知（已恢复的再标记恢复已通知）。
 * `notify-tick` 的开始、汇总、恢复通知三条查询都带 `notify = true`，所以这些行永远不会入发件箱；
 * 进行中的那条即便被静默窗口恢复，也不会发恢复邮件。
 *
 * **时间相对播种时刻**，不写死日期：设计稿的日期是 2026-09-29，而告警列表默认只看最近 30 天，
 * 写死会让它们几天后就从页面上消失。偏移量对应设计稿「今天 14:03」时的各行位置，使概览「最近 24 小时」
 * 恰为 2 条（进行中一条加 12 小时前恢复的一条，与稿一致）。行 id 固定，重复播种不增行、不动已有行。
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface PlannedAlert {
  readonly id: string;
  readonly kind: SystemAlertKind;
  /** 带租户的键（`recipient:<租户 id>`）要等播种时才知道租户 id，所以是函数。 */
  readonly subjectKey: (tenantId: string | null) => string;
  /** 租户编码；全局键为 null。 */
  readonly tenantCode: string | null;
  readonly description: string;
  readonly affectedCalls: number;
  readonly occurrences: number;
  /** 开始时间相对播种时刻的偏移（毫秒，负数表示之前）。 */
  readonly startOffset: number;
  /** 持续毫秒；null 表示进行中。 */
  readonly durationMs: number | null;
}

/** 最近一通未验证话单的 UUID：描述里的写法与 `ingest.ts` 一致。 */
const OPEN_AUTH_TIMEOUT_CALL = 'b0000000-0000-4000-8000-0000000000a1';

export const SEED_ALERT_PLAN: readonly PlannedAlert[] = [
  {
    id: seededUuid('fs-billing:seed:alert:1'),
    kind: 'auth_timeout',
    subjectKey: () => AlertKeys.authTimeout,
    tenantCode: null,
    description: `FreeSWITCH 授权未验证，按 1800 秒放行，最近一通 ${OPEN_AUTH_TIMEOUT_CALL}（按话单到达时间记录）`,
    affectedCalls: 9,
    occurrences: 9,
    startOffset: -11 * MINUTE,
    durationMs: null,
  },
  {
    id: seededUuid('fs-billing:seed:alert:2'),
    kind: 'cdr_failed',
    subjectKey: () => AlertKeys.cdrSave,
    tenantCode: null,
    description: '话单入库或任务入队失败',
    affectedCalls: 12,
    occurrences: 12,
    startOffset: -12 * HOUR,
    durationMs: 17 * MINUTE,
  },
  {
    id: seededUuid('fs-billing:seed:alert:3'),
    kind: 'email_failed',
    subjectKey: (tenantId) => EmailAlertKeys.recipient(tenantId!),
    tenantCode: 'GZT007',
    description:
      '租户邮件（余额不足提醒）的收件人被邮件服务器拒绝，已放弃：EENVELOPE 550: 5.1.1 The email account that you tried to reach does not exist <地址>',
    affectedCalls: 0,
    occurrences: 1,
    startOffset: -27 * HOUR - 30 * MINUTE,
    durationMs: 2 * HOUR + 40 * MINUTE,
  },
  {
    id: seededUuid('fs-billing:seed:alert:4'),
    kind: 'auth_timeout',
    subjectKey: () => AlertKeys.authTimeout,
    tenantCode: null,
    description: `FreeSWITCH 授权未验证，按 1800 秒放行，最近一通 ${OPEN_AUTH_TIMEOUT_CALL}（按话单到达时间记录）`,
    affectedCalls: 23,
    occurrences: 23,
    startOffset: -2 * DAY - 11 * HOUR,
    durationMs: 18 * MINUTE,
  },
  {
    id: seededUuid('fs-billing:seed:alert:5'),
    kind: 'email_failed',
    subjectKey: () => EmailAlertKeys.smtp,
    tenantCode: null,
    description: '余额不足提醒发送失败，已放弃：ETIMEDOUT: Connection timeout',
    affectedCalls: 0,
    occurrences: 1,
    startOffset: -5 * DAY - 2 * HOUR,
    durationMs: 9 * MINUTE,
  },
];

/**
 * 写入示例告警。幂等：行 id 固定，`ON CONFLICT DO NOTHING` 不带目标，所以 id 已存在、或库里已经有同键的进行中告警
 * （真实事件先发生了）都直接跳过，不报错也不改已有行。
 */
export async function seedSystemAlerts(
  tx: Tx,
  now: Date,
  tenantIds: ReadonlyMap<string, string>,
): Promise<void> {
  // 告警的新列是迁移 0020 才有的：迁移测试会在更早的结构上播种，那时没有这些列，也就没有这些示例告警。
  const { rows: columns } = await tx.execute<{ present: boolean }>(sql`
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'system_alerts' and column_name = 'notified_start_at'
    ) as present`);
  if (columns[0]?.present !== true) return;
  const rows = SEED_ALERT_PLAN.map((alert) => {
    const startedAt = new Date(now.getTime() + alert.startOffset);
    const recoveredAt =
      alert.durationMs === null
        ? null
        : new Date(startedAt.getTime() + alert.durationMs);
    const tenantId =
      alert.tenantCode === null ? null : tenantIds.get(alert.tenantCode)!;
    return {
      id: alert.id,
      kind: alert.kind,
      subjectKey: alert.subjectKey(tenantId),
      tenantId,
      description: alert.description,
      affectedCalls: alert.affectedCalls,
      occurrences: alert.occurrences,
      startedAt,
      recoveredAt,
      lastSeenAt: recoveredAt ?? new Date(now.getTime() - 20_000),
      notify: false,
      notifiedStartAt: startedAt,
      notifiedRecoveredAt: recoveredAt,
    };
  });
  await tx.insert(systemAlerts).values(rows).onConflictDoNothing();
}
