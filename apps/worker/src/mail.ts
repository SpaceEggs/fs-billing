import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import {
  createTransport,
  type SendMailOptions,
  type SMTPPoolOptions,
  type Transporter,
} from 'nodemailer';
import type { PgBoss } from 'pg-boss';
import {
  claimDueEmails,
  completeEmail,
  failEmail,
  OUTBOX_LEASE_SECONDS,
  purgeEmailOutbox,
  raiseEmailFailed,
  recoverQuietAlerts,
  recoverSmtpAlert,
  recoverStaleRecipientAlerts,
  releaseClaims,
  retryEmailLater,
  withSystem,
  type ClaimedEmail,
  type PoolDb,
} from '@fs-billing/db';
import { renderMail } from '@fs-billing/shared';
import { isLoopbackHost, type MailSettings } from './config.js';
import { NOTIFY_QUEUE } from './queue.js';

type Logger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;

export const NOTIFY_CRON = '* * * * *';
export const NOTIFY_TIMEZONE = 'Asia/Shanghai';
/** 发件人显示名固定；地址取 MAIL_FROM。 */
export const MAIL_FROM_NAME = 'FS-Billing 计费系统';
const LAST_ERROR_MAX = 300;

// ---------------------------------------------------------------------------
// 传输层：把 nodemailer 收窄成一个小接口，分发逻辑与测试都只依赖它。
// ---------------------------------------------------------------------------

export interface OutgoingMail {
  /** `<发件箱 id>@fs-billing`，重发同一封时不变，让邮件客户端有机会折叠。 */
  readonly messageId: string;
  readonly from: { readonly name: string; readonly address: string };
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}
export interface SendResult {
  /** SMTP 服务器接受的收件人。 */
  readonly accepted: readonly string[];
  /** SMTP 服务器拒绝的收件人。 */
  readonly rejected: readonly string[];
  readonly response: string;
}
export interface MailTransport {
  send(mail: OutgoingMail): Promise<SendResult>;
  close(): void;
}

/** nodemailer 的 Transporter 只用到这两个方法；单元测试可以换成 jsonTransport / streamTransport。 */
export function adaptNodemailer(
  mailer: Pick<Transporter, 'sendMail' | 'close'>,
): MailTransport {
  return {
    async send(mail) {
      const options: SendMailOptions = {
        messageId: mail.messageId,
        from: mail.from,
        to: [...mail.to],
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        // 自动发出的通知：提示收件方的自动回复（休假、退信机器人）不要回应。
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Auto-Response-Suppress': 'All',
        },
      };
      const info = (await mailer.sendMail(options)) as {
        accepted?: unknown[];
        rejected?: unknown[];
        response?: unknown;
      };
      const names = (list: unknown[] | undefined) =>
        list?.map((entry) => {
          if (typeof entry === 'string') return entry;
          const address = (entry as { address?: unknown }).address;
          return typeof address === 'string' ? address : '';
        });
      return {
        // json / stream 传输没有收件人分类，视为全部接受。
        accepted: names(info.accepted) ?? mail.to,
        rejected: names(info.rejected) ?? [],
        response: typeof info.response === 'string' ? info.response : '',
      };
    },
    close: () => mailer.close(),
  };
}

/** SMTP 连接选项。证书校验保持默认（不写 rejectUnauthorized）；debug、logger 关闭（它们会打印认证过程）。 */
export function smtpTransportOptions(
  settings: MailSettings,
  options: { pool: boolean } = { pool: true },
): SMTPPoolOptions {
  const loopback = isLoopbackHost(settings.host);
  return {
    // IPv6 字面量在配置里可以写成 [::1]；nodemailer 要裸地址。
    host: settings.host.replace(/^\[|\]$/g, ''),
    port: settings.port,
    secure: settings.secure,
    // STARTTLS 必须成功；只有回环地址（Mailpit）允许明文。
    requireTLS: !settings.secure && !loopback,
    connectionTimeout: settings.timeoutMs,
    greetingTimeout: settings.timeoutMs,
    socketTimeout: settings.timeoutMs,
    ...(settings.user !== undefined && settings.pass !== undefined
      ? { auth: { user: settings.user, pass: settings.pass } }
      : {}),
    // 一个 tick 内串行、单连接，发完关闭；不做长连接池（空闲连接会被服务器断开）。
    ...(options.pool ? { pool: true, maxConnections: 1 } : {}),
    disableFileAccess: true,
    disableUrlAccess: true,
    logger: false,
    debug: false,
  };
}

export function createMailTransport(
  settings: MailSettings,
  options: { pool: boolean } = { pool: true },
): MailTransport {
  return adaptNodemailer(
    createTransport(smtpTransportOptions(settings, options)),
  );
}

// ---------------------------------------------------------------------------
// 失败分类
// ---------------------------------------------------------------------------

/**
 * - `retry`：连接错误、超时、4xx、限流。退避重试，用尽后 failed。
 * - `auth`：认证失败（535 等）。同样退避重试（管理员可能正在改环境变量），每次都开 `smtp` 告警。
 * - `permanent`：全部收件人被 5xx 拒绝、整封被拒、地址格式错误。直接 failed。
 */
export type SmtpFailureClass = 'retry' | 'auth' | 'permanent';
export interface SmtpFailure {
  readonly class: SmtpFailureClass;
  /** 告警归属：`recipient` 是收件人被拒（租户邮件记到 `recipient:<租户>`），`smtp` 是传输层。 */
  readonly scope: 'smtp' | 'recipient';
  /** 写进 last_error 的摘要：响应码与首行，不含地址，≤ 300 字符。 */
  readonly summary: string;
  /** nodemailer 在 EENVELOPE 错误上带的被拒收件人，写进 `rejected` 列。 */
  readonly rejected?: readonly string[] | undefined;
}

interface SmtpErrorLike {
  code?: unknown;
  command?: unknown;
  response?: unknown;
  responseCode?: unknown;
  message?: unknown;
  rejected?: unknown;
  rejectedErrors?: { responseCode?: unknown }[];
}

const CONNECTION_CODES = new Set([
  'ECONNECTION',
  'ESOCKET',
  'ETIMEDOUT',
  'EDNS',
  'ETLS',
  'EREQUIRETLS',
  'EPROTOCOL',
  'EPROXY',
]);
const AUTH_CODES = new Set(['EAUTH', 'ENOAUTH']);
/**
 * 5xx 但其实是限流 / 发送频率限制：按可重试处理。只留明确的限流措辞——「exceed」「超过」「限制」
 * 会误伤 552「message size exceeds」「mailbox full」这类永久失败。QQ 的实际措辞待运行手册第 3 项实测补充。
 */
const RATE_LIMIT_TEXT =
  /frequen|too many|too fast|rate.?limit|throttl|try again later|频繁|频率|发送过快|请稍后再试/i;
const EMAIL_ADDRESS = /<?[^\s<>()"',;:]+@[^\s<>()"',;:]+>?/g;

/** 响应码与首行，抹掉邮箱地址（服务器常把被拒地址写进响应），折成单行并截断。 */
export function summarizeSmtpError(error: unknown): string {
  const e = (
    typeof error === 'object' && error !== null ? error : {}
  ) as SmtpErrorLike;
  const first = (value: unknown) =>
    typeof value === 'string' ? (value.split(/\r?\n/)[0] ?? '') : '';
  const detail = first(e.response) || first(e.message) || '未知错误';
  const head = [
    typeof e.code === 'string' ? e.code : undefined,
    typeof e.responseCode === 'number' ? String(e.responseCode) : undefined,
  ].filter(Boolean);
  const line = `${head.join(' ')}${head.length > 0 ? ': ' : ''}${detail}`
    .replace(EMAIL_ADDRESS, '<地址>')
    .replace(/\s+/g, ' ');
  return line.length > LAST_ERROR_MAX
    ? `${line.slice(0, LAST_ERROR_MAX - 1)}…`
    : line;
}

export function classifySmtpError(error: unknown): SmtpFailure {
  const e = (
    typeof error === 'object' && error !== null ? error : {}
  ) as SmtpErrorLike;
  const summary = summarizeSmtpError(error);
  const code = typeof e.code === 'string' ? e.code : '';
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : 0;
  const text = `${typeof e.response === 'string' ? e.response : ''} ${typeof e.message === 'string' ? e.message : ''}`;
  const rejected = Array.isArray(e.rejected)
    ? e.rejected.filter((entry): entry is string => typeof entry === 'string')
    : undefined;
  const result = (
    failureClass: SmtpFailureClass,
    scope: 'smtp' | 'recipient' = 'smtp',
  ): SmtpFailure => ({ class: failureClass, scope, summary, rejected });

  if (
    AUTH_CODES.has(code) ||
    (e.command === 'AUTH' && responseCode >= 500) ||
    [530, 534, 535, 538].includes(responseCode)
  )
    return result('auth');
  if (CONNECTION_CODES.has(code)) return result('retry');
  // nodemailer 在发送前本地拒绝的消息（空邮件、超过服务器声明的 SIZE）：没有响应码，重试也不会好。
  if (code === 'EMESSAGE' && responseCode === 0) return result('permanent');
  if (code === 'EENVELOPE') {
    // 收件人在 RCPT TO 阶段被拒；只要有一个是 4xx（暂缓）就整封稍后再试。
    if (e.command === 'RCPT TO' || (e.rejectedErrors?.length ?? 0) > 0) {
      const deferred = e.rejectedErrors?.some(
        (entry) =>
          typeof entry.responseCode === 'number' && entry.responseCode < 500,
      );
      return deferred ||
        (responseCode > 0 && responseCode < 500) ||
        RATE_LIMIT_TEXT.test(text)
        ? result('retry', 'recipient')
        : result('permanent', 'recipient');
    }
    // 其余 EENVELOPE（MAIL FROM、DATA 命令被拒，或本地地址校验失败）：先看响应码。
    if (responseCode >= 400 && responseCode < 500) return result('retry');
    if (e.command === 'DATA' || e.command === 'MAIL FROM')
      return responseCode >= 500 && !RATE_LIMIT_TEXT.test(text)
        ? result('permanent')
        : result('retry');
    // 本地校验（command 为 API）：发件人格式错误是配置问题，收件人格式错误属于收件人。
    return /sender/i.test(text)
      ? result('permanent')
      : result('permanent', 'recipient');
  }
  if (code === 'ECONFIG') return result('permanent');
  if (responseCode >= 400 && responseCode < 500) return result('retry');
  if (responseCode >= 500)
    return RATE_LIMIT_TEXT.test(text) ? result('retry') : result('permanent');
  // 没见过的错误：宁可重试，也不丢通知。
  return result('retry');
}

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
        await settle(email, failure, 'fail', {
          description:
            failure.scope === 'recipient'
              ? `${recipients}邮件（${label}）的收件人被邮件服务器拒绝，已放弃：${failure.summary}`
              : `${label}发送失败，已放弃：${failure.summary}`,
        });
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

// ---------------------------------------------------------------------------
// 定时任务
// ---------------------------------------------------------------------------

export interface NotifyTickOptions {
  /** 邮件配置；SMTP_HOST 未设置时为 undefined：发件箱照常入队，只是不分发。 */
  readonly mail: MailSettings | undefined;
  /** 事件型告警的静默恢复窗口（分钟），ALERT_QUIET_MINUTES。 */
  readonly quietMinutes: number;
  readonly now?: () => Date;
  readonly logger?: Logger | undefined;
  /** 测试注入；默认按 mail 配置建 SMTP 传输。 */
  readonly createTransport?: (settings: MailSettings) => MailTransport;
  /** Worker 的停止信号，传给分发。 */
  readonly signal?: AbortSignal | undefined;
}

/**
 * 每分钟一次的 Worker 任务（阶段 9 设计：定时任务只有一个）。PR 2 的部分：
 * 事件型告警静默恢复（recoverQuietAlerts，窗口取 ALERT_QUIET_MINUTES）→ 收件人告警 7 天窗口恢复 → 分发发件箱。
 * PR 4 在分发之前加上告警的开始、汇总、恢复通知。
 */
export async function runNotifyTick(
  db: PoolDb,
  options: NotifyTickOptions,
): Promise<DispatchSummary | undefined> {
  const clock = options.now ?? (() => new Date());
  await withSystem(db, async (tx) => {
    const at = clock();
    await recoverQuietAlerts(tx, { quietMinutes: options.quietMinutes, at });
    await recoverStaleRecipientAlerts(tx, { at });
  });
  if (!options.mail) return undefined;
  const transport = (options.createTransport ?? createMailTransport)(
    options.mail,
  );
  try {
    return await dispatchOutbox(db, {
      transport,
      settings: options.mail,
      now: clock,
      logger: options.logger,
      signal: options.signal,
    });
  } finally {
    transport.close();
  }
}

/** 北京时间的日期，用来每天只清理一次发件箱。 */
const beijingDay = (at: Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: NOTIFY_TIMEZONE }).format(at);

export async function startNotifyJobs(
  boss: PgBoss,
  db: PoolDb,
  options: NotifyTickOptions,
) {
  const logger = options.logger;
  let purgedOn = '';
  await boss.work(NOTIFY_QUEUE, async () => {
    try {
      await runNotifyTick(db, options);
      // 发件箱满 180 天的已结束行每天清一次（启动后的第一个 tick 也清一次）。
      const today = beijingDay((options.now ?? (() => new Date()))());
      if (today !== purgedOn) {
        // 清理失败不影响邮件：记日志，明天再试。
        purgedOn = today;
        try {
          const removed = await withSystem(db, purgeEmailOutbox);
          if (removed > 0) logger?.info(`已清理发件箱 ${removed} 行`);
        } catch (error) {
          logger?.error({ err: error }, '清理发件箱失败');
        }
      }
    } catch (error) {
      logger?.error({ err: error }, '邮件任务失败');
      throw error;
    }
  });
  // 错过的分钟没有补发的意义：下一分钟的 tick 会认领所有到期的邮件。
  await boss.schedule(NOTIFY_QUEUE, NOTIFY_CRON, null, { tz: NOTIFY_TIMEZONE });
}

/** mail:test 用的随机 Message-ID（不进发件箱）。 */
export const testMessageId = () => `<test-${randomUUID()}@fs-billing>`;
