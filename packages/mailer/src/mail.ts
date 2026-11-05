import { randomUUID } from 'node:crypto';
import {
  createTransport,
  type SendMailOptions,
  type SMTPPoolOptions,
  type Transporter,
} from 'nodemailer';
import { isLoopbackHost, type MailSettings } from './config.js';

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
 * 会误伤 552「message size exceeds」「mailbox full, quota exceeded」这类永久失败。每日限额只认带「每日发送」语义的措辞：
 * `daily quota`、`quota … per day / daily`、`quota … today … tomorrow / try again`、`daily limit`、`daily sending limit`、
 * `发送上限`、`当日…发送 / 上限 / 限额`。单独的 `sending limit`、`当日`、`quota`、`today` 都不算
 * （「message size exceeds sending limit」「当日收件箱已满」仍是永久失败）。
 */
const RATE_LIMIT_TEXT =
  /frequen|too many|too fast|rate.?limit|throttl|try again later|daily.{0,10}quota|quota.{0,30}(?:per day|daily)|quota.{0,30}today.{0,40}(?:tomorrow|try again)|daily limit|daily sending limit|发送上限|当日.{0,6}(?:发送|上限|限额)|频繁|频率|发送过快|请稍后再试/i;
/**
 * DATA 阶段的 5xx 其实是收件人被拒（QQ：`550 The recipient may contain a non-existent account…`，nodemailer 报
 * `EMESSAGE`，不是 EENVELOPE）。只认明确点名收件人 / 账号不存在的措辞，宁可归 smtp 也不误报成收件人问题。
 */
const RECIPIENT_REJECT_TEXT =
  /recipient|non-?existent|no such user|mailbox unavailable|不存在/i;
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
  if (responseCode >= 500) {
    if (RATE_LIMIT_TEXT.test(text)) return result('retry');
    // 点名收件人的 5xx（EMESSAGE / DATA 阶段）：永久失败，告警归收件人而不是全局 smtp。
    return (code === 'EMESSAGE' || e.command === 'DATA') &&
      RECIPIENT_REJECT_TEXT.test(text)
      ? result('permanent', 'recipient')
      : result('permanent');
  }
  // 没见过的错误：宁可重试，也不丢通知。
  return result('retry');
}

/** mail:test 用的随机 Message-ID（不进发件箱）。 */
export const testMessageId = () => `<test-${randomUUID()}@fs-billing>`;
