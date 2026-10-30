import { z } from 'zod';
import { ALERT_KIND_LABELS } from '../../mail/templates.js';
import {
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminTimestampSchema,
} from './common.js';

/**
 * 系统告警（阶段 9 设计「系统告警页」「端点与契约」）。后台专用，门户没有对应端点。
 * 告警类型与 `system_alerts.kind` 的取值一致；中文名取自邮件模板的 `ALERT_KIND_LABELS`，页面和邮件同一份。
 */
export const alertKindSchema = z.enum([
  'auth_timeout',
  'cdr_failed',
  'email_failed',
  'partition_failed',
  'statement_mismatch',
  'audit_failed',
  'raw_archive_failed',
]);
export type AlertKind = z.infer<typeof alertKindSchema>;
/** 与邮件的 `ALERT_KIND_LABELS` 同一份：每个类型都有中文名（测试断言），缺失时退回类型名。 */
export function alertKindLabel(kind: AlertKind): string {
  return ALERT_KIND_LABELS[kind] ?? kind;
}

export const adminAlertStatusFilterSchema = z.enum([
  'all',
  'open',
  'recovered',
]);
/** `all` 不限时间。24 小时 / 30 天的口径见数据库层的 `alertWindowPredicate`。 */
export const adminAlertWindowSchema = z.enum(['24h', '30d', 'all']);
export type AdminAlertWindow = z.infer<typeof adminAlertWindowSchema>;

export const adminSystemAlertsQuerySchema = adminPageQuerySchema.extend({
  status: adminAlertStatusFilterSchema.default('all'),
  kind: alertKindSchema.optional(),
  window: adminAlertWindowSchema.default('30d'),
});
export type AdminSystemAlertsQuery = z.infer<
  typeof adminSystemAlertsQuerySchema
>;

export const adminAlertIdParamsSchema = z.strictObject({ alertId: z.uuid() });

const tenantRefSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
});

export const adminSystemAlertSchema = z.strictObject({
  id: z.uuid(),
  kind: alertKindSchema,
  kindLabel: z.string().min(1),
  description: z.string(),
  startedAt: adminTimestampSchema,
  /** 最近一次事件的数据库时间（按话单到达时间记录，不是话单自己的时间）。 */
  lastSeenAt: adminTimestampSchema,
  recoveredAt: adminTimestampSchema.nullable(),
  status: z.enum(['open', 'recovered']),
  /** 持续时长（秒）：进行中算到请求时刻，已恢复算到恢复时刻。 */
  durationSeconds: z.int().nonnegative(),
  /** 影响的通话数（「期间放行 23 通未经验证话单」）。 */
  affectedCalls: z.int().nonnegative(),
  occurrences: z.int().positive(),
  /** 只有按租户分的告警（对账、账单核对、收件人被拒）带租户。 */
  tenant: tenantRefSchema.nullable(),
});
export type AdminSystemAlert = z.infer<typeof adminSystemAlertSchema>;

export const adminSystemAlertsResponseSchema = z.strictObject({
  items: z.array(adminSystemAlertSchema).max(100),
  pagination: adminPageInfoSchema,
  /** 进行中的告警总数，不受筛选影响（页面「进行中 N」）。 */
  openCount: z.int().nonnegative(),
});
export type AdminSystemAlertsResponse = z.infer<
  typeof adminSystemAlertsResponseSchema
>;

/** 导航红点与概览：`open` 是红点依据，`last24h` 与列表端点 `window=24h` 的 `total` 同一个谓词。 */
export const adminSystemAlertsSummaryResponseSchema = z.strictObject({
  open: z.int().nonnegative(),
  last24h: z.int().nonnegative(),
  /** 进行中的告警里最近一条的开始时间；没有进行中的告警为 null。 */
  lastOpenedAt: adminTimestampSchema.nullable(),
});
export type AdminSystemAlertsSummaryResponse = z.infer<
  typeof adminSystemAlertsSummaryResponseSchema
>;

export const adminAlertNoticeSchema = z.strictObject({
  template: z.enum(['alert_start', 'alert_digest', 'alert_recovered']),
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'skipped']),
  /** 入发件箱的时间。 */
  queuedAt: adminTimestampSchema,
  sentAt: adminTimestampSchema.nullable(),
  attempts: z.int().nonnegative(),
  /** `skipped` 的原因（如 `no_recipients`）；不含收件人地址。 */
  skipReason: z.string().nullable(),
});

export const adminSystemAlertDetailSchema = adminSystemAlertSchema.extend({
  /** 这类告警是否发邮件（`email_failed` 恒为否；迁移前的历史告警为否）。 */
  notify: z.boolean(),
  /**
   * `auth_timeout`：告警期间入库的未验证话单，受影响最多的 5 个租户；`truncated` 为真表示告警持续超过 30 天，
   * 只统计了最近 30 天。其他类型为 null。
   */
  affectedTenants: z
    .strictObject({
      items: z
        .array(tenantRefSchema.extend({ count: z.int().positive() }))
        .max(5),
      truncated: z.boolean(),
    })
    .nullable(),
  /**
   * `auth_timeout`：涉及话单的开始时间范围（最早、最晚）与对应的北京日，用于跳转租户话单标签页
   * 并筛选「仅看未经验证」。没有统计到话单为 null。
   */
  cdrRange: z
    .strictObject({
      from: adminTimestampSchema,
      to: adminTimestampSchema,
      fromDay: z.iso.date(),
      toDay: z.iso.date(),
    })
    .nullable(),
  /** `cdr_failed` 的未归属 / 校验失败类：跳转未归属话单页所需的 `reason`（与 `tag`）筛选。 */
  unassignedFilter: z
    .strictObject({ reason: z.string().min(1), tag: z.string().nullable() })
    .nullable(),
  /** 这条告警相关的开始、汇总、恢复邮件，按入队时间升序，最多 50 封；不含收件人地址。 */
  notices: z.array(adminAlertNoticeSchema).max(50),
});
export type AdminSystemAlertDetail = z.infer<
  typeof adminSystemAlertDetailSchema
>;

export const ADMIN_ALERT_RECIPIENTS_MAX = 20;
export const ADMIN_ALERT_DIGEST_MINUTES_MAX = 1440;
/** 规则同租户邮箱：小写、去重，每项是单个纯邮箱地址，至多 20 个，允许为空。 */
export const adminAlertRecipientsSchema = z
  .array(z.email())
  .max(100)
  .transform((emails) => [
    ...new Set(emails.map((email) => email.toLowerCase())),
  ])
  .pipe(z.array(z.email()).max(ADMIN_ALERT_RECIPIENTS_MAX));
export const adminAlertDigestMinutesSchema = z
  .int()
  .min(1)
  .max(ADMIN_ALERT_DIGEST_MINUTES_MAX);

export const adminAlertSettingsResponseSchema = z.strictObject({
  recipients: z.array(z.email()).max(ADMIN_ALERT_RECIPIENTS_MAX),
  digestMinutes: adminAlertDigestMinutesSchema,
  version: z.int().positive(),
  /** 与 Worker 同一个信号：API 环境里 `SMTP_HOST` 与 `MAIL_FROM` 都已设置（不含凭据）；为假时页面写「邮件发送未配置，告警和提醒不会发出」。 */
  mailEnabled: z.boolean(),
});
export type AdminAlertSettingsResponse = z.infer<
  typeof adminAlertSettingsResponseSchema
>;

export const adminAlertSettingsUpdateRequestSchema = z.strictObject({
  recipients: adminAlertRecipientsSchema,
  digestMinutes: adminAlertDigestMinutesSchema,
  expectedVersion: z.int().positive(),
});
export type AdminAlertSettingsUpdateRequest = z.infer<
  typeof adminAlertSettingsUpdateRequestSchema
>;
export const adminAlertSettingsUpdateResponseSchema =
  adminAlertSettingsResponseSchema.extend({
    /** 内容没变时不保存也不写日志，为 null。 */
    auditId: z.uuid().nullable(),
  });
export type AdminAlertSettingsUpdateResponse = z.infer<
  typeof adminAlertSettingsUpdateResponseSchema
>;
