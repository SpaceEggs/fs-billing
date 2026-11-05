import { z } from 'zod';
import { adminTimestampSchema } from './common.js';

/**
 * 邮箱设置（阶段 9 PR 4，设计 `docs/smtp-settings-design.md`「接口」）。
 *
 * 响应永远不含密码或密文：只有 `passwordSet` 表示是否存了密码。
 * `source` 决定 Worker 实际用哪套配置：
 * - `page`（`smtp_settings.managed = true`）：用页面保存的配置；
 * - `env`（未接管且环境变量配了 `SMTP_HOST` 与 `MAIL_FROM`）：继续用环境变量；
 * - `none`：都没有配置，不发信。
 */
export const mailSettingsSourceSchema = z.enum(['page', 'env', 'none']);
export type MailSettingsSource = z.infer<typeof mailSettingsSourceSchema>;

export const mailTestResultSchema = z.enum([
  'ok',
  'auth',
  'retry',
  'permanent',
]);
export type MailTestResult = z.infer<typeof mailTestResultSchema>;

/** 环境变量来源的非秘密值；没配置的项为 null。绝不包含 `SMTP_PASS`。 */
export const adminMailSettingsEnvironmentSchema = z.strictObject({
  host: z.string().nullable(),
  port: z.int().min(1).max(65535).nullable(),
  secure: z.boolean().nullable(),
  username: z.string().nullable(),
  mailFrom: z.email().nullable(),
  siteUrl: z.url().nullable(),
});
export type AdminMailSettingsEnvironment = z.infer<
  typeof adminMailSettingsEnvironmentSchema
>;

/** 发件箱状态：最近成功发送、等待发送封数、最近一次发送尝试是否失败。 */
export const adminMailDeliverySchema = z.strictObject({
  lastSentAt: adminTimestampSchema.nullable(),
  pendingCount: z.int().nonnegative(),
  lastAttemptFailed: z.boolean(),
});
export type AdminMailDelivery = z.infer<typeof adminMailDeliverySchema>;

export const adminMailSettingsResponseSchema = z.strictObject({
  managed: z.boolean(),
  enabled: z.boolean(),
  host: z.string().nullable(),
  port: z.int().min(1).max(65535).nullable(),
  secure: z.boolean().nullable(),
  username: z.string().nullable(),
  /** 只有是否已保存密码；明文与密文都不返回。 */
  passwordSet: z.boolean(),
  mailFrom: z.email().nullable(),
  siteUrl: z.url().nullable(),
  version: z.int().positive(),
  lastTestAt: adminTimestampSchema.nullable(),
  lastTestOk: z.boolean().nullable(),
  lastTestResult: mailTestResultSchema.nullable(),
  source: mailSettingsSourceSchema,
  env: adminMailSettingsEnvironmentSchema,
  /** 是否配置了 `SETTINGS_ENCRYPTION_KEY`。 */
  keyConfigured: z.boolean(),
  /** 已存密文能否用当前密钥解开；没有密文时为 true。 */
  passwordUsable: z.boolean(),
  /** 非生产环境为 true：页面据此决定是否显示“不加密”（Mailpit 开发用）。 */
  allowPlaintext: z.boolean(),
  delivery: adminMailDeliverySchema,
});
export type AdminMailSettingsResponse = z.infer<
  typeof adminMailSettingsResponseSchema
>;

const blankToNull = <T extends z.ZodType>(schema: T) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? null : value,
    schema.nullable(),
  );

const mailSettingsConfigFields = {
  enabled: z.boolean(),
  host: blankToNull(z.string().trim().max(255)),
  port: blankToNull(z.int().min(1).max(65535)),
  secure: z.boolean().nullable(),
  username: blankToNull(z.string().trim().max(320)),
  mailFrom: blankToNull(z.email()),
  siteUrl: blankToNull(z.url()),
};

export const adminMailSettingsUpdateRequestSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  ...mailSettingsConfigFields,
  /** 不填（或空字符串）表示沿用已存密码；只有 host 与 username 都没变时才允许。 */
  password: z.string().max(500).optional(),
});
export type AdminMailSettingsUpdateRequest = z.infer<
  typeof adminMailSettingsUpdateRequestSchema
>;

export const adminMailSettingsUpdateResponseSchema =
  adminMailSettingsResponseSchema.extend({
    /** 内容没变时不保存也不写日志，为 null。 */
    auditId: z.uuid().nullable(),
  });
export type AdminMailSettingsUpdateResponse = z.infer<
  typeof adminMailSettingsUpdateResponseSchema
>;

export const adminMailSettingsTestRequestSchema = z.strictObject({
  enabled: z.boolean(),
  host: blankToNull(z.string().trim().max(255)),
  port: blankToNull(z.int().min(1).max(65535)),
  secure: z.boolean().nullable(),
  username: blankToNull(z.string().trim().max(320)),
  password: z.string().max(500).optional(),
  mailFrom: blankToNull(z.email()),
  siteUrl: blankToNull(z.url()),
  /** 测试收件人。 */
  to: z.email(),
});
export type AdminMailSettingsTestRequest = z.infer<
  typeof adminMailSettingsTestRequestSchema
>;

export const adminMailSettingsTestResponseSchema = z.strictObject({
  /** SMTP 失败不是 5xx：HTTP 200、`ok: false`，`result` 为分类。 */
  ok: z.boolean(),
  result: mailTestResultSchema,
});
export type AdminMailSettingsTestResponse = z.infer<
  typeof adminMailSettingsTestResponseSchema
>;
