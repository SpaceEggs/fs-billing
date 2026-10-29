import { z } from 'zod';
import { cdrStatusSchema } from '../cdr-fields.js';
import { currencySchema } from '../identity.js';
import { adminRateEntrySchema } from './rates.js';
import { adminStatementVersionFiguresSchema } from './statements.js';
import { statementMonthSchema } from '../statement-fields.js';
import {
  adminNonnegativeAmountSchema,
  adminNonzeroAmountSchema,
  adminPositiveAmountSchema,
  adminTimestampSchema,
} from './common.js';

export const auditActionSchema = z.enum([
  'tenant_create',
  'tenant_edit',
  'tenant_disable',
  'tenant_enable',
  'tenant_settings_update',
  'portal_account_create',
  'reset_password',
  'portal_account_disable',
  'portal_account_enable',
  'balance_topup',
  'balance_credit_topup',
  'balance_gift',
  'balance_adjustment',
  'rate_entry_edit',
  'rate_import',
  'rate_export',
  'rate_copy',
  'rate_schedule_cancel',
  'receivable_confirm',
  'receivable_void',
  'receivable_payment_reverse',
  'admin_create',
  'admin_disable',
  'admin_enable',
  'cdr_export',
  'statement_regenerate',
  'unassigned_assign',
  'unassigned_ignore',
  'unassigned_unignore',
  'cdr_delete',
  'credential_bootstrap',
  'alert_settings_update',
]);
export type AuditAction = z.infer<typeof auditActionSchema>;
export const auditChangeSchema = z.strictObject({
  field: z.enum([
    'name',
    'status',
    'overdraftLimit',
    'lowBalanceThreshold',
    'emails',
    'contactName',
    'contactPhone',
    'remark',
    'email',
    'prefix',
    'country',
    'rate',
    'amount',
    'receivedOn',
    'code',
    'currency',
    'balance',
    'callCount',
    'alertRecipients',
    'digestMinutes',
  ]),
  before: z.union([z.string(), z.array(z.string()), z.null()]),
  after: z.union([z.string(), z.array(z.string()), z.null()]),
});
const contentFields = {
  summary: z.string().trim().min(1),
  changes: z.array(auditChangeSchema),
};
/** 管理员操作者。 */
export const auditActorSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().min(1),
});
/** 没有管理员的事件（auth:bootstrap 命令行）：来源标签，形如 cli:auth:bootstrap@主机/系统用户。 */
export const auditSystemActorSchema = z.strictObject({
  label: z.string().trim().min(1).max(200),
});
export type AuditActor = z.infer<typeof auditActorSchema>;
export type AuditSystemActor = z.infer<typeof auditSystemActorSchema>;
export const auditTargetKindSchema = z.enum([
  'tenant',
  'portal_account',
  'ledger_entry',
  'rate_version',
  'receivable',
  'admin',
  'statement',
  'unassigned_batch',
  'alert_settings',
]);
const envelopeFields = {
  id: z.uuid(),
  actor: auditActorSchema,
  occurredAt: adminTimestampSchema,
  tenantId: z.uuid().nullable(),
  target: z.strictObject({ kind: auditTargetKindSchema, id: z.uuid() }),
};
function variantOf<
  const Action extends AuditAction,
  Fields extends z.ZodRawShape,
  Actor extends z.ZodType,
>(actor: Actor, action: Action, fields: Fields) {
  return z.strictObject({
    ...envelopeFields,
    actor,
    action: z.literal(action),
    content: z.strictObject({ ...contentFields, ...fields }),
  });
}
function auditVariant<
  const Action extends AuditAction,
  Fields extends z.ZodRawShape,
>(action: Action, fields: Fields) {
  return variantOf(auditActorSchema, action, fields);
}
/** bootstrap 被拒绝或失败的原因（固定枚举，不取异常消息）。 */
export const credentialBootstrapErrorCodes = [
  'PASSWORD_RULES',
  'PROFILE_NOT_FOUND',
  'CREDENTIAL_EXISTS',
  'MULTIPLE_CREDENTIALS',
  'UNKNOWN',
] as const;
const balanceFields = {
  ledgerEntryId: z.uuid(),
  amount: adminPositiveAmountSchema,
  currency: currencySchema,
};
const rateFields = { rateVersionId: z.uuid() };
export const auditPayloadSchema = z.discriminatedUnion('action', [
  auditVariant('tenant_create', {
    code: z.string().min(1),
    currency: currencySchema,
    rateVersionId: z.uuid(),
  }),
  auditVariant('tenant_edit', {}),
  auditVariant('tenant_disable', {}),
  auditVariant('tenant_enable', {}),
  auditVariant('tenant_settings_update', {}),
  auditVariant('portal_account_create', { email: z.email() }),
  auditVariant('reset_password', {}),
  auditVariant('portal_account_disable', {}),
  auditVariant('portal_account_enable', {}),
  auditVariant('balance_topup', balanceFields),
  auditVariant('balance_credit_topup', balanceFields),
  auditVariant('balance_gift', balanceFields),
  auditVariant('balance_adjustment', {
    ...balanceFields,
    amount: adminNonzeroAmountSchema,
    reason: z.string().trim().min(1).max(2000),
  }),
  auditVariant('rate_entry_edit', rateFields),
  auditVariant('rate_import', rateFields),
  auditVariant('rate_export', rateFields),
  auditVariant('rate_copy', {
    ...rateFields,
    sourceTenantId: z.uuid(),
    sourceVersionId: z.uuid(),
  }),
  auditVariant('rate_schedule_cancel', {
    cancelledVersionId: z.uuid(),
    entries: z.array(
      adminRateEntrySchema.extend({
        iso: adminRateEntrySchema.shape.iso.default(''),
        description: adminRateEntrySchema.shape.description.default(''),
      }),
    ),
  }),
  auditVariant('receivable_confirm', {
    ...balanceFields,
    settlementId: z.uuid(),
    receivedOn: z.iso.date(),
  }),
  auditVariant('receivable_void', {
    ...balanceFields,
    voidId: z.uuid(),
    adjustmentLedgerEntryId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
  }),
  auditVariant('receivable_payment_reverse', {
    ...balanceFields,
    settlementId: z.uuid(),
    reversalId: z.uuid(),
    reason: z.string().trim().min(1).max(2000),
  }),
  auditVariant('admin_create', { email: z.email() }),
  auditVariant('admin_disable', {}),
  auditVariant('admin_enable', {}),
  auditVariant('cdr_export', {
    rowCount: z.int().nonnegative(),
    filters: z.strictObject({
      from: z.iso.date(),
      to: z.iso.date(),
      status: cdrStatusSchema,
      callee: z
        .string()
        .regex(/^[1-9][0-9]{0,14}$/)
        .optional(),
      country: z.string().min(1).max(200).optional(),
      unverifiedOnly: z.boolean(),
    }),
  }),
  /** target 是账单头部的 id；补建（created）时 before 为 null，无变化（changed 为假）时仍记录这次操作。 */
  auditVariant('statement_regenerate', {
    month: statementMonthSchema,
    created: z.boolean(),
    changed: z.boolean(),
    before: adminStatementVersionFiguresSchema.nullable(),
    after: adminStatementVersionFiguresSchema,
  }),
  /** target 是分配批次的 id；tenantId 是目标租户。sourceTag 为空表示按勾选而不是按分组选择。 */
  auditVariant('unassigned_assign', {
    sourceTag: z.string().nullable(),
    assignedCount: z.int().nonnegative(),
    noRateCount: z.int().nonnegative(),
    blockedCount: z.int().nonnegative(),
    chargeTotal: adminNonnegativeAmountSchema,
    currency: currencySchema,
    affectedMonths: z.array(statementMonthSchema),
  }),
  /** 忽略与撤销忽略没有批次表：target 取本条审计自身的 id，tenantId 为空。 */
  auditVariant('unassigned_ignore', {
    count: z.int().positive(),
    reason: z.string().trim().min(1).max(2000),
    sourceTag: z.string().nullable(),
  }),
  auditVariant('unassigned_unignore', { count: z.int().positive() }),
  /** 一个月一条；target 是账单头部的 id。 */
  auditVariant('cdr_delete', {
    month: statementMonthSchema,
    deletedCount: z.int().nonnegative(),
    range: z.strictObject({ from: z.iso.date(), to: z.iso.date() }),
    confirmedCode: z.string().min(1),
  }),
  /**
   * auth:bootstrap 命令行没有管理员会话，操作者是 { label }（operation_logs.admin_id 为空）；
   * target 是被初始化凭据的资料 id（admin 或 portal_account）。内容里没有密码、哈希、会话 token，
   * 也没有异常消息：errorCode 取固定枚举。
   */
  variantOf(auditSystemActorSchema, 'credential_bootstrap', {
    mode: z.enum(['create', 'replace']),
    result: z.enum(['succeeded', 'rejected', 'failed']),
    errorCode: z.enum(credentialBootstrapErrorCodes).nullable(),
    revokedSessions: z.int().nonnegative(),
  }),
  /**
   * 系统告警设置（阶段 9）：全局单行，没有自己的 uuid，target 取本条审计自身的 id，tenantId 为空。
   * changes 含接收邮箱与汇总间隔的前后值（管理员自己的运营邮箱，写入日志可接受）；version 是保存后的版本。
   */
  auditVariant('alert_settings_update', { version: z.int().positive() }),
]);
export const auditContentSchema = z.discriminatedUnion('action', [
  auditPayloadSchema.options[0].pick({ action: true, content: true }),
  ...auditPayloadSchema.options
    .slice(1)
    .map((option) => option.pick({ action: true, content: true })),
]);

export type AuditChange = z.infer<typeof auditChangeSchema>;
export type AuditContent = z.infer<typeof auditContentSchema>;
export type AuditPayload = z.infer<typeof auditPayloadSchema>;
