import type { FastifyBaseLogger } from 'fastify';
import {
  claimDueEmails,
  completeEmail,
  failEmail,
  OUTBOX_LEASE_SECONDS,
  raiseEmailFailed,
  recoverSmtpAlert,
  releaseClaims,
  retryEmailLater,
  withSystem,
  type ClaimedEmail,
  type PoolDb,
} from '@fs-billing/db';
import { renderMail } from '@fs-billing/shared';
import {
  classifySmtpError,
  MAIL_FROM_NAME,
  summarizeSmtpError,
  type MailSettings,
  type MailTransport,
  type OutgoingMail,
  type SendResult,
  type SmtpFailure,
} from '@fs-billing/mailer';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

// ---------------------------------------------------------------------------
// 分发
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  readonly transport: MailTransport;
  readonly settings: Pick<
    MailSettings,
    'from' | 'ratePerTick' | 'maxAttempts' | 'siteUrl' | 'timeoutMs'
  >;
  /** 时钟；测试注入假时钟推进退避，默认真实时间。 */
  readonly now?: () => Date;
  readonly logger?: Logger | undefined;
  /** 停止信号（Worker 收到 SIGTERM）：每封之间检查，已认领但没发的释放回 pending。 */
  readonly signal?: AbortSignal | undefined;
}
export interface DispatchSummary {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  /** 没来得及发（租约快到期或收到停止信号）而释放回 pending 的封数。 */
  readonly released: number;
}

const TEMPLATE_LABELS: Record<ClaimedEmail['template'], string> = {
  balance_low: '余额不足提醒',
  balance_suspended: '停机通知',
  alert_start: '故障告警',
  alert_digest: '故障汇总',
  alert_recovered: '故障恢复',
  test: '测试邮件',
};

/**
 * 认领到期的邮件并串行发送（单连接）。成功：`sent`，余额类通知同事务记 balance_alert_deliveries，并恢复 `smtp` 告警；
 * 失败按 {@link classifySmtpError} 分三类，**不在失败时丢弃邮件**。每封的结果各自一个事务，一封失败不影响其余。
 *
 * 至少一次，不是恰好一次：SMTP 接受后、`sent` 提交前进程崩溃，租约到期后会重发（Message-ID 不变）。
 *
 * 租约与运行时间：一封邮件最坏的发送时间由连接、问候、套接字三个超时决定，约 3 × SMTP_TIMEOUT_MS（预算）。
 * 租约取 max(2 分钟, 预算 + 60 秒)，每封发送前检查「现在 + 预算 < 租约到期」，不满足就停止发送并把没发的释放回
 * pending（次数退回）。所以发送一旦开始就一定在租约到期前结束，整个 tick 的运行时间受租约约束（最长约 7 分钟，
 * 小于 notify-tick 任务的 10 分钟过期），不需要在配置里再限制 MAIL_RATE_PER_MINUTE。
 * 结果写入还带 attempts 守卫：万一仍有迟到的旧处理者，它的写入不会覆盖更新的认领。
 */
export async function dispatchOutbox(
  db: PoolDb,
  options: DispatchOptions,
): Promise<DispatchSummary> {
  const { transport, settings, logger, signal } = options;
  const clock = options.now ?? (() => new Date());
  const sendBudgetMs = 3 * settings.timeoutMs;
  const leaseSeconds = Math.max(
    OUTBOX_LEASE_SECONDS,
    Math.ceil(sendBudgetMs / 1000) + 60,
  );
  const claimed = await withSystem(db, (tx) =>
    claimDueEmails(tx, {
      limit: settings.ratePerTick,
      now: clock(),
      leaseSeconds,
    }),
  );
  const summary = {
    claimed: claimed.length,
    sent: 0,
    retried: 0,
    failed: 0,
    released: 0,
  };

  /** 失败的后续：先改状态（退避重试或永久失败），改成了才写告警，一个事务。迟到的旧处理者什么也不写。 */
  const settle = (
    email: ClaimedEmail,
    failure: SmtpFailure,
    outcome: 'retry' | 'fail',
    alert: { description: string } | undefined,
    rejected?: readonly string[],
  ) =>
    withSystem(db, async (tx) => {
      const now = clock();
      const changed =
        outcome === 'retry'
          ? await retryEmailLater(tx, email, { error: failure.summary, now })
          : await failEmail(tx, email, {
              error: failure.summary,
              rejected: rejected ?? failure.rejected,
            });
      if (!changed || !alert) return;
      const recipientScope = failure.scope === 'recipient';
      await raiseEmailFailed(tx, {
        tenantId: recipientScope ? email.tenantId : null,
        adminRecipients: recipientScope && !email.tenantId,
        description: alert.description,
        at: now,
      });
    });

  for (let index = 0; index < claimed.length; index++) {
    const email = claimed[index]!;
    const stopReason = signal?.aborted
      ? '收到停止信号'
      : email.lockedUntil &&
          clock().getTime() + sendBudgetMs >= email.lockedUntil.getTime()
        ? '租约即将到期'
        : undefined;
    if (stopReason) {
      const rest = claimed.slice(index);
      summary.released = await withSystem(db, (tx) => releaseClaims(tx, rest));
      logger?.warn(
        { released: summary.released },
        `${stopReason}，停止发送，剩余已认领的邮件释放回待发`,
      );
      break;
    }
    // 崩溃恢复时租约到期被重新认领，次数可能已超过上限：直接放弃，不再发送。
    if (email.attempts > settings.maxAttempts) {
      const failure: SmtpFailure = {
        class: 'permanent',
        scope: 'smtp',
        summary: '租约到期后已超过最大尝试次数，不再发送',
      };
      await settle(email, failure, 'fail', {
        description: `${TEMPLATE_LABELS[email.template]}发送失败，已放弃：${failure.summary}`,
      });
      summary.failed++;
      continue;
    }
    let mail: OutgoingMail;
    let balance: string | undefined;
    try {
      const rendered = renderMail(email.template, email.params, {
        siteUrl: settings.siteUrl,
      });
      const balanceParam = email.params.balance;
      balance = typeof balanceParam === 'string' ? balanceParam : undefined;
      mail = {
        messageId: `<${email.id}@fs-billing>`,
        from: { name: MAIL_FROM_NAME, address: settings.from },
        to: email.recipients,
        ...rendered,
      };
    } catch (error) {
      // 快照不合法（代码缺陷或手工改库）：重试也不会好，直接失败并留下可见的告警。
      logger?.error({ err: error, outboxId: email.id }, '邮件模板渲染失败');
      const failure: SmtpFailure = {
        class: 'permanent',
        scope: 'smtp',
        summary: '模板渲染失败：快照不符合模板要求',
      };
      await settle(email, failure, 'fail', {
        description: `${TEMPLATE_LABELS[email.template]}无法渲染，已放弃：快照不符合模板要求`,
      });
      summary.failed++;
      continue;
    }

    let result: SendResult;
    try {
      result = await transport.send(mail);
    } catch (error) {
      const failure = classifySmtpError(error);
      const exhausted = email.attempts >= settings.maxAttempts;
      logger?.warn(
        {
          outboxId: email.id,
          attempts: email.attempts,
          failure: failure.class,
          scope: failure.scope,
        },
        `邮件发送失败：${failure.summary}`,
      );
      const label = TEMPLATE_LABELS[email.template];
      const recipients = email.tenantId ? '租户' : '管理员告警';
      if (failure.class === 'auth') {
        // 认证失败每次都告警；是否继续重试看次数（管理员可能正在改环境变量）。
        await settle(email, failure, exhausted ? 'fail' : 'retry', {
          description: exhausted
            ? `SMTP 认证失败，请检查 SMTP_USER / SMTP_PASS；${label}已放弃：${failure.summary}`
            : `SMTP 认证失败，请检查 SMTP_USER / SMTP_PASS：${failure.summary}`,
        });
      } else if (failure.class === 'permanent' || exhausted) {
        // DATA 阶段的拒绝没有逐个点名收件人；邮件只有一个收件人时，被点名的只可能是它。
        const rejected =
          failure.scope === 'recipient' &&
          (failure.rejected?.length ?? 0) === 0 &&
          mail.to.length === 1
            ? mail.to
            : undefined;
        await settle(
          email,
          failure,
          'fail',
          {
            description:
              failure.scope === 'recipient'
                ? `${recipients}邮件（${label}）的收件人被邮件服务器拒绝，已放弃：${failure.summary}`
                : `${label}发送失败，已放弃：${failure.summary}`,
          },
          rejected,
        );
      } else {
        await settle(email, failure, 'retry', undefined);
      }
      if (failure.class === 'permanent' || exhausted) summary.failed++;
      else summary.retried++;
      continue;
    }

    if (result.accepted.length === 0) {
      // 没有任何收件人被接受（传输层没有抛错的情形）：按全部被拒的永久失败处理。
      const failure: SmtpFailure = {
        class: 'permanent',
        scope: 'recipient',
        summary: summarizeSmtpError({ message: '所有收件人都被服务器拒绝' }),
      };
      await settle(
        email,
        failure,
        'fail',
        {
          description: `${email.tenantId ? '租户' : '管理员告警'}邮件（${TEMPLATE_LABELS[email.template]}）的收件人全部被邮件服务器拒绝，已放弃`,
        },
        result.rejected,
      );
      summary.failed++;
      continue;
    }

    const completed = await withSystem(db, async (tx) => {
      const now = clock();
      const done = await completeEmail(tx, email, {
        accepted: result.accepted,
        rejected: result.rejected,
        balance,
        now,
      });
      if (!done) return false;
      await recoverSmtpAlert(tx, now);
      // 部分收件人被拒、其余接受：整封算 sent，被拒地址写 rejected；租户邮件开 recipient:<租户>，
      // 管理员邮件开 recipient:admin（都走 7 天窗口恢复，不被 smtp 告警的恢复清掉）。
      if (result.rejected.length > 0)
        await raiseEmailFailed(tx, {
          tenantId: email.tenantId,
          adminRecipients: !email.tenantId,
          description: `${TEMPLATE_LABELS[email.template]}有 ${result.rejected.length} 个收件人被邮件服务器拒绝，其余已送达`,
          at: now,
        });
      return true;
    });
    if (!completed) {
      // 发送期间租约被别人接走（发送比租约慢）：这次已经发出的邮件不记结果，结果以新的认领为准。
      logger?.warn(
        { outboxId: email.id },
        '发送完成时认领已被接走，结果不写入',
      );
      continue;
    }
    if (result.rejected.length > 0)
      logger?.warn(
        { outboxId: email.id, rejected: result.rejected.length },
        '部分收件人被邮件服务器拒绝',
      );
    summary.sent++;
  }
  return summary;
}
