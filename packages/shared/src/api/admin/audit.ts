import { z } from 'zod';
import { adminTimestampSchema } from './common.js';

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
  'receivable_confirm',
  'admin_create',
  'admin_disable',
  'admin_enable',
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
  ]),
  before: z.union([z.string(), z.array(z.string()), z.null()]),
  after: z.union([z.string(), z.array(z.string()), z.null()]),
});
export const auditContentSchema = z.strictObject({
  summary: z.string().min(1),
  changes: z.array(auditChangeSchema),
  ledgerEntryId: z.uuid().optional(),
  rateVersionId: z.uuid().optional(),
  sourceTenantId: z.uuid().optional(),
  settlementId: z.uuid().optional(),
  reason: z.string().optional(),
});
export const auditPayloadSchema = z.strictObject({
  id: z.uuid(),
  action: auditActionSchema,
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
    ]),
    id: z.uuid(),
  }),
  content: auditContentSchema,
});

export type AuditChange = z.infer<typeof auditChangeSchema>;
export type AuditContent = z.infer<typeof auditContentSchema>;
export type AuditPayload = z.infer<typeof auditPayloadSchema>;
