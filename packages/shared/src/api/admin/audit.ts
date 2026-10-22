import { z } from 'zod';
import { cdrStatusSchema } from '../cdr-fields.js';
import { currencySchema } from '../identity.js';
import { adminRateEntrySchema } from './rates.js';
import { adminStatementVersionFiguresSchema } from './statements.js';
import { statementMonthSchema } from '../statement-fields.js';
import {
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
  ]),
  before: z.union([z.string(), z.array(z.string()), z.null()]),
  after: z.union([z.string(), z.array(z.string()), z.null()]),
});
const contentFields = {
  summary: z.string().trim().min(1),
  changes: z.array(auditChangeSchema),
};
const envelopeFields = {
  id: z.uuid(),
  actor: z.strictObject({ id: z.uuid(), name: z.string().min(1) }),
  occurredAt: adminTimestampSchema,
  tenantId: z.uuid().nullable(),
  target: z.strictObject({
    kind: z.enum([
      'tenant',
      'portal_account',
      'ledger_entry',
      'rate_version',
      'receivable',
      'admin',
      'statement',
    ]),
    id: z.uuid(),
  }),
};
function auditVariant<
  const Action extends AuditAction,
  Fields extends z.ZodRawShape,
>(action: Action, fields: Fields) {
  return z.strictObject({
    ...envelopeFields,
    action: z.literal(action),
    content: z.strictObject({ ...contentFields, ...fields }),
  });
}
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
