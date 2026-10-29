import { z } from 'zod';
import { beijingDateTimeParts } from '../api/beijing-time.js';
import { currencySchema } from '../api/identity.js';
import { moneyAmountSchema } from '../api/money.js';

/**
 * 邮件模板（阶段 9）：纯函数 `renderMail(template, params, context) → { subject, text, html }`，
 * Worker 和测试共用，不依赖数据库。params 是入队时存进发件箱的快照（jsonb），渲染时再校验一遍；
 * 发件箱不存渲染后的正文。
 *
 * 内容边界：正文不含主叫、被叫、计费号码、原始话单、门户账号邮箱；告警说明里的通话 UUID 一律抹掉
 * （告警只写类型与数量，需要时去页面查）。租户名称与编码来自管理员输入：HTML 一律转义，主题去掉换行（防头部注入）。
 */

export const MAIL_TEMPLATES = [
  'balance_low',
  'balance_suspended',
  'alert_start',
  'alert_digest',
  'alert_recovered',
  'test',
] as const;
export type MailTemplate = (typeof MAIL_TEMPLATES)[number];

const instant = z.iso.datetime({ offset: true });
const minutes = z.number().int().min(0);
const count = z.number().int().min(0);
const text = z.string().max(2000);

const tenantFields = {
  tenantCode: z.string().min(1).max(200),
  tenantName: z.string().min(1).max(500),
  currency: currencySchema,
  balance: moneyAmountSchema,
  overdraftLimit: moneyAmountSchema,
};

export const balanceLowParamsSchema = z.strictObject({
  ...tenantFields,
  threshold: moneyAmountSchema,
  /** 可用额度 = 余额 + 透支额度。 */
  available: moneyAmountSchema,
});
export const balanceSuspendedParamsSchema = z.strictObject(tenantFields);

export const alertStartParamsSchema = z.strictObject({
  alerts: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(100),
        description: text,
        startedAt: instant,
      }),
    )
    .min(1)
    .max(200),
});
export const alertDigestParamsSchema = z.strictObject({
  alerts: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(100),
        description: text,
        startedAt: instant,
        durationMinutes: minutes,
        /** 距上次开始或汇总邮件新增的事件数。 */
        added: count,
        total: count,
        /** 受影响最多的租户编码（最多 5 个）。 */
        topTenants: z.array(z.string().min(1).max(200)).max(5),
      }),
    )
    .min(1)
    .max(200),
});
export const alertRecoveredParamsSchema = z.strictObject({
  alerts: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(100),
        startedAt: instant,
        recoveredAt: instant,
        durationMinutes: minutes,
        total: count,
        affectedCalls: count,
      }),
    )
    .min(1)
    .max(200),
});
export const testParamsSchema = z.strictObject({ sentAt: instant });

export const mailParamsSchemas = {
  balance_low: balanceLowParamsSchema,
  balance_suspended: balanceSuspendedParamsSchema,
  alert_start: alertStartParamsSchema,
  alert_digest: alertDigestParamsSchema,
  alert_recovered: alertRecoveredParamsSchema,
  test: testParamsSchema,
} as const satisfies Record<MailTemplate, z.ZodType>;
export type MailParams<T extends MailTemplate> = z.infer<
  (typeof mailParamsSchemas)[T]
>;

export interface RenderContext {
  /** 站点根地址（APP_PUBLIC_URL）；没有则邮件不含链接。 */
  readonly siteUrl?: string | undefined;
}
export interface RenderedMail {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** 告警类型的中文名；未知类型原样显示。 */
export const ALERT_KIND_LABELS: Readonly<Record<string, string>> = {
  auth_timeout: '授权超时',
  cdr_failed: '话单处理失败',
  email_failed: '邮件发送失败',
  partition_failed: '分区维护失败',
  statement_mismatch: '账单核对异常',
  audit_failed: '审计写入失败',
  raw_archive_failed: '原始话单归档失败',
};
const kindLabel = (kind: string) => ALERT_KIND_LABELS[kind] ?? kind;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 单行文字：换行与控制字符折成空格。用于主题和正文里的名称。 */
export function oneLine(value: string): string {
  // Cc：控制字符（含 CR、LF）；Zl、Zp：Unicode 行分隔符与段分隔符。
  return value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
}

const SUBJECT_MAX = 200;
function subjectOf(value: string): string {
  const line = oneLine(value);
  return line.length > SUBJECT_MAX
    ? `${line.slice(0, SUBJECT_MAX - 1)}…`
    : line;
}

/** 告警说明：抹掉通话 UUID，折成单行。 */
function describe(value: string): string {
  return oneLine(value.replace(UUID, '…'));
}

/** 北京时间 `2026-10-29 14:03`。 */
export function formatBeijingTime(value: string | Date): string {
  const p = beijingDateTimeParts(value);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)}`;
}
const at = (value: string) => `${formatBeijingTime(value)} 北京时间`;

export function formatDuration(totalMinutes: number): string {
  if (totalMinutes < 1) return '不到 1 分钟';
  if (totalMinutes < 60) return `${totalMinutes} 分钟`;
  if (totalMinutes < 1440) {
    const hours = Math.floor(totalMinutes / 60);
    const rest = totalMinutes % 60;
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`;
  }
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`;
}

const amount = (currency: string, value: string) => `${currency} ${value}`;

/** 一行文字及其 HTML：正文按行组织，每行同时给纯文本与转义后的 HTML。 */
interface Section {
  readonly heading?: string;
  readonly lines: readonly string[];
}

const STYLE = {
  body: 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;line-height:1.6;color:#1f2933;',
  h2: 'font-size:16px;margin:16px 0 4px;',
  p: 'margin:2px 0;',
  foot: 'margin-top:20px;color:#6b7785;font-size:12px;',
} as const;

function layout(
  title: string,
  sections: readonly Section[],
  link: string | undefined,
) {
  const textParts = [title, ''];
  const htmlParts = [
    `<h1 style="font-size:18px;margin:0 0 8px;">${escapeHtml(title)}</h1>`,
  ];
  for (const section of sections) {
    if (section.heading) {
      textParts.push(section.heading);
      htmlParts.push(
        `<h2 style="${STYLE.h2}">${escapeHtml(section.heading)}</h2>`,
      );
    }
    for (const line of section.lines) {
      textParts.push(line);
      htmlParts.push(`<p style="${STYLE.p}">${escapeHtml(line)}</p>`);
    }
    textParts.push('');
  }
  if (link) {
    textParts.push(`查看详情：${link}`, '');
    htmlParts.push(
      `<p style="${STYLE.p}">查看详情：<a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
    );
  }
  const foot = '此邮件由 FS-Billing 计费系统自动发送，请勿直接回复。';
  textParts.push(foot);
  htmlParts.push(`<p style="${STYLE.foot}">${escapeHtml(foot)}</p>`);
  return {
    text: textParts.join('\n'),
    html: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body style="${STYLE.body}">${htmlParts.join('')}</body></html>`,
  };
}

const alertsLink = (context: RenderContext) =>
  context.siteUrl ? `${context.siteUrl}/admin/system-alerts` : undefined;

function uniqueKinds(kinds: readonly string[]): string {
  return [...new Set(kinds.map(kindLabel))].join('、');
}

const renderers: {
  [T in MailTemplate]: (
    params: MailParams<T>,
    context: RenderContext,
  ) => RenderedMail;
} = {
  balance_low(params, context) {
    const name = oneLine(params.tenantName);
    const title = `余额不足：${name}`;
    return {
      subject: subjectOf(
        `【余额不足】${name} 余额 ${amount(params.currency, params.balance)}`,
      ),
      ...layout(
        title,
        [
          {
            lines: [
              `租户：${oneLine(params.tenantCode)}（${name}）`,
              `当前余额：${amount(params.currency, params.balance)}`,
              `提醒阈值：${amount(params.currency, params.threshold)}`,
              `透支额度：${amount(params.currency, params.overdraftLimit)}`,
              `可用额度：${amount(params.currency, params.available)}`,
              '充值后恢复；可用额度用完后将无法呼出。',
            ],
          },
        ],
        context.siteUrl,
      ),
    };
  },
  balance_suspended(params, context) {
    const name = oneLine(params.tenantName);
    return {
      subject: subjectOf(`【已停机】${name} 可用额度已用完`),
      ...layout(
        `已停机：${name}`,
        [
          {
            lines: [
              `租户：${oneLine(params.tenantCode)}（${name}）`,
              `当前余额：${amount(params.currency, params.balance)}`,
              `透支额度：${amount(params.currency, params.overdraftLimit)}`,
              '余额与透支额度已用完：新的呼叫将被拒绝（SIP 拒绝，原因「余额不足」），进行中的通话不受影响。',
              '充值后自动恢复。',
            ],
          },
        ],
        context.siteUrl,
      ),
    };
  },
  alert_start(params, context) {
    const kinds = uniqueKinds(params.alerts.map((alert) => alert.kind));
    return {
      subject: subjectOf(
        `【故障告警】${params.alerts.length} 项告警开始：${kinds}`,
      ),
      ...layout(
        `故障告警：${params.alerts.length} 项告警开始`,
        params.alerts.map((alert) => ({
          heading: kindLabel(alert.kind),
          lines: [
            describe(alert.description),
            `开始时间：${at(alert.startedAt)}（按话单到达时间记录）`,
          ],
        })),
        alertsLink(context),
      ),
    };
  },
  alert_digest(params, context) {
    return {
      subject: subjectOf(`【故障汇总】${params.alerts.length} 项告警仍在进行`),
      ...layout(
        `故障汇总：${params.alerts.length} 项告警仍在进行`,
        params.alerts.map((alert) => ({
          heading: kindLabel(alert.kind),
          lines: [
            describe(alert.description),
            `持续 ${formatDuration(alert.durationMinutes)}（开始于 ${at(alert.startedAt)}）`,
            `距上次通知新增 ${alert.added} 次，累计 ${alert.total} 次`,
            ...(alert.topTenants.length > 0
              ? [
                  `受影响最多的租户：${alert.topTenants.map(oneLine).join('、')}`,
                ]
              : []),
          ],
        })),
        alertsLink(context),
      ),
    };
  },
  alert_recovered(params, context) {
    const [only] = params.alerts;
    const subject =
      params.alerts.length === 1 && only
        ? `【故障恢复】${kindLabel(only.kind)} 已恢复，持续 ${formatDuration(only.durationMinutes)}`
        : `【故障恢复】${params.alerts.length} 项告警已恢复：${uniqueKinds(params.alerts.map((alert) => alert.kind))}`;
    return {
      subject: subjectOf(subject),
      ...layout(
        `故障恢复：${params.alerts.length} 项告警已恢复`,
        params.alerts.map((alert) => ({
          heading: kindLabel(alert.kind),
          lines: [
            `开始：${at(alert.startedAt)}`,
            `恢复：${at(alert.recoveredAt)}（持续 ${formatDuration(alert.durationMinutes)}）`,
            `累计 ${alert.total} 次，影响 ${alert.affectedCalls} 通话`,
          ],
        })),
        alertsLink(context),
      ),
    };
  },
  test(params) {
    return {
      subject: '【测试邮件】FS-Billing',
      ...layout(
        '测试邮件',
        [
          {
            lines: [
              `发送时间：${at(params.sentAt)}`,
              '收到这封邮件说明 SMTP 配置可用。',
            ],
          },
        ],
        undefined,
      ),
    };
  },
};

/** 校验快照并渲染；params 不合法时抛 ZodError（调用方记为永久失败，不重试）。 */
export function renderMail<T extends MailTemplate>(
  template: T,
  params: unknown,
  context: RenderContext = {},
): RenderedMail {
  const parsed = mailParamsSchemas[template].parse(params) as MailParams<T>;
  return renderers[template](parsed, context);
}
