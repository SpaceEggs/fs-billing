import { and, asc, eq, gte, inArray, lt, lte, or, sql } from 'drizzle-orm';
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

/** `email_failed` 告警的键。`smtp`：传输层（连接、认证、整封被拒）；`recipient:<租户>`：租户的收件人被拒。 */
export const EmailAlertKeys = {
  smtp: 'smtp',
  recipient: (tenantId: string) => `recipient:${tenantId}`,
} as const;
const RECIPIENT_PREFIX = EmailAlertKeys.recipient('');

export interface EnqueueEmailInput {
  /** 幂等键：重跑同一事务、重复 tick 都不会产生第二封。 */
  readonly dedupeKey: string;
  readonly template: EmailTemplate;
  /** 渲染所需的快照；不存渲染后的正文。 */
  readonly params: Record<string, unknown>;
  /** 入队时的收件人快照；之后改设置不影响已入队的邮件。空列表入队为 skipped。 */
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
}

/** 去掉空白、统一小写、去重（租户与告警设置的邮箱规则也是小写、去重）。 */
function normalizeRecipients(recipients: readonly string[]): string[] {
  return [
    ...new Set(
      recipients.map((entry) => entry.trim().toLowerCase()).filter(Boolean),
    ),
  ];
}

/** 入队一封邮件；与调用方的状态变化在同一事务。`INSERT … ON CONFLICT (dedupe_key) DO NOTHING`。 */
export async function enqueueEmail(
  tx: Tx,
  input: EnqueueEmailInput,
): Promise<EnqueuedEmail> {
  const recipients = normalizeRecipients(input.recipients);
  const skipReason =
    input.skipReason ?? (recipients.length === 0 ? 'no_recipients' : undefined);
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
  if (inserted) return { ...inserted, created: true };
  const [existing] = await tx
    .select({ id: emailOutbox.id, status: emailOutbox.status })
    .from(emailOutbox)
    .where(eq(emailOutbox.dedupeKey, input.dedupeKey));
  return { ...existing!, created: false };
}

export type ClaimedEmail = typeof emailOutbox.$inferSelect;

/**
 * 认领到期的邮件：`pending` 且到了重试时间，或 `sending` 但租约已过期（上一个分发器崩溃了）。
 * `FOR UPDATE SKIP LOCKED` 让多个分发器各拿不同的行；认领即 attempts + 1 并续租。
 */
export async function claimDueEmails(
  tx: Tx,
  options: { limit: number; now: Date; leaseSeconds?: number },
): Promise<ClaimedEmail[]> {
  const { now, limit } = options;
  const leaseEnd = new Date(
    now.getTime() + (options.leaseSeconds ?? OUTBOX_LEASE_SECONDS) * 1000,
  );
  const due = tx
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      or(
        and(
          eq(emailOutbox.status, 'pending'),
          lte(emailOutbox.nextAttemptAt, now),
        ),
        and(
          eq(emailOutbox.status, 'sending'),
          lt(emailOutbox.lockedUntil, now),
        ),
      ),
    )
    .orderBy(asc(emailOutbox.nextAttemptAt), asc(emailOutbox.createdAt))
    .limit(limit)
    .for('update', { skipLocked: true });
  const claimed = await tx
    .update(emailOutbox)
    .set({
      status: 'sending',
      lockedUntil: leaseEnd,
      attempts: sql`${emailOutbox.attempts} + 1`,
    })
    .where(inArray(emailOutbox.id, due))
    .returning();
  return claimed.sort(
    (a, b) =>
      a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() ||
      a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

/** 只有仍是 `sending` 的行才会被改：租约被别人接走并已完成时，这次写入落空（返回 false）。 */
const stillSending = (id: string) =>
  and(eq(emailOutbox.id, id), eq(emailOutbox.status, 'sending'));

/**
 * 标记发送成功：`sent`、`sent_at`、SMTP 返回的收件人分类；余额类通知同事务记一行 `balance_alert_deliveries`
 * （recipients 为 SMTP 实际接收的地址，`outbox_id` 唯一，重复完成不会记两次）。
 */
export async function completeEmail(
  tx: Tx,
  email: Pick<ClaimedEmail, 'id' | 'template' | 'tenantId'>,
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
    .where(stillSending(email.id))
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
    .where(stillSending(email.id))
    .returning({ id: emailOutbox.id });
  return updated.length > 0;
}

/** 永久失败：`failed`，不再自动重试；`mail:requeue` 可以把它放回去。 */
export async function failEmail(
  tx: Tx,
  id: string,
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
    .where(stillSending(id))
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
 * 记一次 `email_failed` 告警（`notify = false`，只出现在页面和概览，不发邮件）。
 * `tenantId` 有值用 `recipient:<租户>` 键并带租户，否则用 `smtp`。
 */
export async function raiseEmailFailed(
  tx: Tx,
  input: {
    tenantId?: string | null | undefined;
    description: string;
    at?: Date | undefined;
  },
): Promise<void> {
  await raiseAlert(tx, {
    kind: 'email_failed',
    subjectKey: input.tenantId
      ? EmailAlertKeys.recipient(input.tenantId)
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

/** `recipient:<租户>` 告警：7 天内没有新的拒收就恢复（按最近一次拒收的时间）。 */
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
