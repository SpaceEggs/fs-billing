import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { raiseAlert, recoverAlert, recoverAlertsWhere } from './alerts.js';
import type { Tx } from './client.js';
import {
  balanceAlertDeliveries,
  emailOutbox,
  systemAlerts,
  type EmailTemplate,
} from './schema.js';

/**
 * 邮件发件箱（阶段 9 设计「邮件发送管线」）。业务事务只负责把「要发这封邮件」写进来（`enqueueEmail`），
 * 与触发它的状态变化在同一事务提交；Worker 之后认领、发送、重试。本文件只管表和状态机，不碰 SMTP。
 *
 * 状态机：
 *   enqueue        → pending（有收件人）或 skipped（没有收件人 / 租户停用，不重试，不是故障）
 *   pending        → sending（认领，attempts + 1，租约 2 分钟）
 *   sending        → sent / pending（退避重试）/ failed（永久失败或尝试用尽）
 *   sending 租约到期 → 被下一次认领重新拿走（进程崩溃后至少一次重发）
 *   failed         → pending（requeueFailedEmails，运维 CLI mail:requeue）
 * 所有时间都由调用方传入（默认数据库 now()），测试用假时钟推进。
 */

export const DEFAULT_MAIL_MAX_ATTEMPTS = 6;
/** 认领租约：进程崩溃后到期自动释放。 */
export const OUTBOX_LEASE_SECONDS = 120;
/**
 * 第 n 次尝试失败后到下一次尝试的间隔（秒）：1 分钟、5 分钟、15 分钟、1 小时、3 小时。
 * 共 6 次尝试时累计约 4 小时 20 分钟；`MAIL_MAX_ATTEMPTS` 调大后超出的部分沿用最后一档。
 */
export const MAIL_BACKOFF_SECONDS = [60, 300, 900, 3600, 10800] as const;

/** `attempts` 是刚失败的那次的序号（从 1 起）。 */
export function mailBackoffSeconds(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), MAIL_BACKOFF_SECONDS.length);
  return MAIL_BACKOFF_SECONDS[index - 1]!;
}

/** 收件人被拒的 `recipient:<租户>` 告警：这么多天没有新拒收就恢复。 */
export const RECIPIENT_ALERT_WINDOW_DAYS = 7;

/**
 * `email_failed` 告警的键。`smtp`：传输层（连接、认证、整封被拒）；`recipient:<租户>`：租户的收件人被拒；
 * `recipient:admin`：管理员告警邮件（没有租户）的收件人被拒——它不能挂在 `smtp` 上，否则下一封成功的邮件
 * 会把它恢复掉，下一次拒收又重开，告警来回开关。
 */
export const EmailAlertKeys = {
  smtp: 'smtp',
  recipient: (tenantId: string) => `recipient:${tenantId}`,
  recipientAdmin: 'recipient:admin',
} as const;
const RECIPIENT_PREFIX = EmailAlertKeys.recipient('');

export interface EnqueueEmailInput {
  /** 幂等键：重跑同一事务、重复 tick 都不会产生第二封。 */
  readonly dedupeKey: string;
  readonly template: EmailTemplate;
  /** 渲染所需的快照；不存渲染后的正文。 */
  readonly params: Record<string, unknown>;
  /** 入队时的收件人快照；之后改设置不影响已入队的邮件。空列表（或全部无效）入队为 skipped。 */
  readonly recipients: readonly string[];
  readonly tenantId?: string | null | undefined;
  /** 显式跳过（例如 `tenant_disabled`）；不给且收件人为空时记 `no_recipients`。 */
  readonly skipReason?: string | undefined;
  /** 入队时间；默认数据库 now()。 */
  readonly at?: Date | undefined;
}

export interface EnqueuedEmail {
  readonly id: string;
  /** false：同一个 dedupeKey 已经入过队，这次没有写入。 */
  readonly created: boolean;
  readonly status: 'pending' | 'skipped' | 'sending' | 'sent' | 'failed';
  /** 因为不是单个纯邮箱地址而被丢弃的收件人条数。 */
  readonly droppedRecipients: number;
}

const recipientSchema = z.email();

/**
 * 去掉空白、统一小写、去重，并且每个收件人必须是单个纯邮箱地址（zod email）：带逗号、显示名（`A <a@b.c>`）、
 * 尖括号、空格的条目丢弃。丢弃而不是抛错——入队通常和余额变动在同一个事务里，抛错会回滚业务事务；
 * 全部被丢弃的邮件和没有收件人一样入队为 skipped（原因 `invalid_recipients`），状态机照常前进（决定 26）。
 */
function normalizeRecipients(recipients: readonly string[]): {
  valid: string[];
  dropped: number;
} {
  const seen = new Set<string>();
  let dropped = 0;
  for (const entry of recipients) {
    const address = entry.trim().toLowerCase();
    if (address === '') continue;
    if (recipientSchema.safeParse(address).success) seen.add(address);
    else dropped++;
  }
  return { valid: [...seen], dropped };
}

/** 入队一封邮件；与调用方的状态变化在同一事务。`INSERT … ON CONFLICT (dedupe_key) DO NOTHING`。 */
export async function enqueueEmail(
  tx: Tx,
  input: EnqueueEmailInput,
): Promise<EnqueuedEmail> {
  const { valid: recipients, dropped } = normalizeRecipients(input.recipients);
  const skipReason =
    input.skipReason ??
    (recipients.length === 0
      ? dropped > 0
        ? 'invalid_recipients'
        : 'no_recipients'
      : undefined);
  const [inserted] = await tx
    .insert(emailOutbox)
    .values({
      dedupeKey: input.dedupeKey,
      template: input.template,
      params: input.params,
      recipients,
      tenantId: input.tenantId ?? null,
      status: skipReason === undefined ? 'pending' : 'skipped',
      skipReason: skipReason ?? null,
      ...(input.at ? { createdAt: input.at, nextAttemptAt: input.at } : {}),
    })
    .onConflictDoNothing({ target: emailOutbox.dedupeKey })
    .returning({ id: emailOutbox.id, status: emailOutbox.status });
  if (inserted)
    return { ...inserted, created: true, droppedRecipients: dropped };
  const [existing] = await tx
    .select({ id: emailOutbox.id, status: emailOutbox.status })
    .from(emailOutbox)
    .where(eq(emailOutbox.dedupeKey, input.dedupeKey));
  return { ...existing!, created: false, droppedRecipients: dropped };
}

export type ClaimedEmail = typeof emailOutbox.$inferSelect;

/**
 * 认领到期的邮件：`pending` 且到了重试时间，或 `sending` 但租约已过期（上一个分发器崩溃了）。
 * `FOR UPDATE SKIP LOCKED` 让多个分发器各拿不同的行；认领即 attempts + 1 并续租。
 * 选行放在 `MATERIALIZED` 的 CTE 里：带 LIMIT 的 SKIP LOCKED 子查询若被计划器并入外层 UPDATE，
 * 可能认领超过 LIMIT 的行，或在重新执行时拿到别的行。
 */
export async function claimDueEmails(
  tx: Tx,
  options: { limit: number; now: Date; leaseSeconds?: number },
): Promise<ClaimedEmail[]> {
  const { now, limit } = options;
  const leaseEnd = new Date(
    now.getTime() + (options.leaseSeconds ?? OUTBOX_LEASE_SECONDS) * 1000,
  );
  const { rows } = await tx.execute<{ id: string }>(sql`
    WITH due AS MATERIALIZED (
      SELECT id FROM email_outbox
      WHERE (status = 'pending' AND next_attempt_at <= ${now}::timestamptz)
         OR (status = 'sending' AND locked_until < ${now}::timestamptz)
      ORDER BY next_attempt_at, created_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE email_outbox o
    SET status = 'sending', locked_until = ${leaseEnd}::timestamptz, attempts = o.attempts + 1
    FROM due WHERE o.id = due.id
    RETURNING o.id`);
  if (rows.length === 0) return [];
  const claimed = await tx
    .select()
    .from(emailOutbox)
    .where(
      inArray(
        emailOutbox.id,
        rows.map((row) => row.id),
      ),
    );
  return claimed.sort(
    (a, b) =>
      a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/**
 * 结果写入的守卫：仍是 `sending`，**并且 attempts 等于认领时的值**。租约到期后别的分发器重新认领会把 attempts + 1，
 * 所以迟到的旧处理者（慢发送、进程冻结后恢复）的写入落空（返回 false），不会覆盖更新的认领或已完成的结果。
 */
const stillClaimed = (email: { id: string; attempts: number }) =>
  and(
    eq(emailOutbox.id, email.id),
    eq(emailOutbox.status, 'sending'),
    eq(emailOutbox.attempts, email.attempts),
  );

/**
 * 释放还没开始发送的认领（租约快到期、收到停止信号）：回到 `pending`、次数退回（这次没有真的尝试），
 * `next_attempt_at` 不变所以下一个 tick 马上能再认领。同样受 {@link stillClaimed} 守卫。
 */
export async function releaseClaims(
  tx: Tx,
  emails: readonly { id: string; attempts: number }[],
): Promise<number> {
  let released = 0;
  for (const email of emails) {
    const rows = await tx
      .update(emailOutbox)
      .set({
        status: 'pending',
        lockedUntil: null,
        attempts: sql`${emailOutbox.attempts} - 1`,
      })
      .where(stillClaimed(email))
      .returning({ id: emailOutbox.id });
    released += rows.length;
  }
  return released;
}

/**
 * 标记发送成功：`sent`、`sent_at`、SMTP 返回的收件人分类；余额类通知同事务记一行 `balance_alert_deliveries`
 * （recipients 为 SMTP 实际接收的地址，`outbox_id` 唯一，重复完成不会记两次）。
 */
export async function completeEmail(
  tx: Tx,
  email: Pick<ClaimedEmail, 'id' | 'attempts' | 'template' | 'tenantId'>,
  result: {
    accepted: readonly string[];
    rejected: readonly string[];
    /** 余额类通知的余额（已由模板校验过的小数字符串）。 */
    balance?: string | undefined;
    now: Date;
  },
): Promise<boolean> {
  const updated = await tx
    .update(emailOutbox)
    .set({
      status: 'sent',
      sentAt: result.now,
      lockedUntil: null,
      accepted: [...result.accepted],
      rejected: [...result.rejected],
      lastError: null,
    })
    .where(stillClaimed(email))
    .returning({ id: emailOutbox.id });
  if (updated.length === 0) return false;
  const kind =
    email.template === 'balance_low'
      ? 'low_balance'
      : email.template === 'balance_suspended'
        ? 'suspended'
        : undefined;
  if (kind && email.tenantId && result.balance !== undefined)
    await tx
      .insert(balanceAlertDeliveries)
      .values({
        tenantId: email.tenantId,
        kind,
        balance: result.balance,
        recipients: [...result.accepted],
        sentAt: result.now,
        outboxId: email.id,
      })
      .onConflictDoNothing({ target: balanceAlertDeliveries.outboxId });
  return true;
}

/** 退避重试：回到 `pending`，`next_attempt_at = now + 退避[attempts]`。 */
export async function retryEmailLater(
  tx: Tx,
  email: Pick<ClaimedEmail, 'id' | 'attempts'>,
  options: { error: string; now: Date },
): Promise<boolean> {
  const next = new Date(
    options.now.getTime() + mailBackoffSeconds(email.attempts) * 1000,
  );
  const updated = await tx
    .update(emailOutbox)
    .set({
      status: 'pending',
      nextAttemptAt: next,
      lockedUntil: null,
      lastError: options.error,
    })
    .where(stillClaimed(email))
    .returning({ id: emailOutbox.id });
  return updated.length > 0;
}

/** 永久失败：`failed`，不再自动重试；`mail:requeue` 可以把它放回去。 */
export async function failEmail(
  tx: Tx,
  email: Pick<ClaimedEmail, 'id' | 'attempts'>,
  options: { error: string; rejected?: readonly string[] | undefined },
): Promise<boolean> {
  const updated = await tx
    .update(emailOutbox)
    .set({
      status: 'failed',
      lockedUntil: null,
      lastError: options.error,
      ...(options.rejected ? { rejected: [...options.rejected] } : {}),
    })
    .where(stillClaimed(email))
    .returning({ id: emailOutbox.id });
  return updated.length > 0;
}

/**
 * 把 `failed` 的邮件放回 `pending`（QQ 每日额度恢复后补发）。尝试次数清零，给足一轮完整的重试。
 * `id` 与 `since`（按入队时间）二选一，调用方保证。返回放回的封数。
 */
export async function requeueFailedEmails(
  tx: Tx,
  options: { id: string } | { since: Date },
  now: Date = new Date(),
): Promise<number> {
  const target =
    'id' in options
      ? eq(emailOutbox.id, options.id)
      : gte(emailOutbox.createdAt, options.since);
  const rows = await tx
    .update(emailOutbox)
    .set({
      status: 'pending',
      attempts: 0,
      nextAttemptAt: now,
      lockedUntil: null,
    })
    .where(and(eq(emailOutbox.status, 'failed'), target))
    .returning({ id: emailOutbox.id });
  return rows.length;
}

/** 清理满 180 天的已结束行（`email_outbox_purge()`，SECURITY DEFINER）。返回删除的行数。 */
export async function purgeEmailOutbox(tx: Tx): Promise<number> {
  const { rows } = await tx.execute<{ removed: string }>(
    sql`select email_outbox_purge() as removed`,
  );
  return Number(rows[0]!.removed);
}

/**
 * 记一次 `email_failed` 告警（`notify = false`，只出现在页面和概览，不发邮件）。键：
 * `tenantId` 有值 → `recipient:<租户>`（带租户）；`adminRecipients` → `recipient:admin`；否则 `smtp`。
 */
export async function raiseEmailFailed(
  tx: Tx,
  input: {
    tenantId?: string | null | undefined;
    /** 管理员告警邮件（没有租户）的收件人被拒。 */
    adminRecipients?: boolean | undefined;
    description: string;
    at?: Date | undefined;
  },
): Promise<void> {
  await raiseAlert(tx, {
    kind: 'email_failed',
    subjectKey: input.tenantId
      ? EmailAlertKeys.recipient(input.tenantId)
      : input.adminRecipients
        ? EmailAlertKeys.recipientAdmin
        : EmailAlertKeys.smtp,
    tenantId: input.tenantId ?? null,
    description: input.description,
    at: input.at,
  });
}

/** `smtp` 告警：下一封邮件发送成功即恢复。 */
export function recoverSmtpAlert(tx: Tx, at?: Date): Promise<number> {
  return recoverAlert(tx, {
    kind: 'email_failed',
    subjectKey: EmailAlertKeys.smtp,
    at,
  });
}

/** `recipient:<租户>` 告警：租户的通知邮箱列表被修改后恢复（保存租户设置时调用）。 */
export function recoverRecipientAlert(
  tx: Tx,
  tenantId: string,
  at?: Date,
): Promise<number> {
  return recoverAlert(tx, {
    kind: 'email_failed',
    subjectKey: EmailAlertKeys.recipient(tenantId),
    at,
  });
}

/**
 * `recipient:admin` 告警：管理员告警接收邮箱被修改后恢复。
 * 由 `saveAlertSettings`（alert-notify.ts）在接收邮箱列表变化时同事务调用；列表没变则只靠 7 天窗口恢复。
 */
export function recoverAdminRecipientAlert(tx: Tx, at?: Date): Promise<number> {
  return recoverAlert(tx, {
    kind: 'email_failed',
    subjectKey: EmailAlertKeys.recipientAdmin,
    at,
  });
}

/** `recipient:*`（含 `recipient:admin`）告警：7 天内没有新的拒收就恢复（按最近一次拒收的时间）。 */
export function recoverStaleRecipientAlerts(
  tx: Tx,
  options: { at?: Date; windowDays?: number } = {},
): Promise<number> {
  const now = options.at ?? sql`now()`;
  const days = options.windowDays ?? RECIPIENT_ALERT_WINDOW_DAYS;
  return recoverAlertsWhere(
    tx,
    and(
      eq(systemAlerts.kind, 'email_failed'),
      sql`starts_with(${systemAlerts.subjectKey}, ${RECIPIENT_PREFIX})`,
      sql`${systemAlerts.lastSeenAt} <= ${now}::timestamptz - ${days} * interval '1 day'`,
    )!,
    options.at,
  );
}
