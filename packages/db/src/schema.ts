import { sql } from 'drizzle-orm';
import { authUsers } from './auth-schema.js';
import type { RatePreviewPayload } from './admin/rate-preview.js';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

// 结构的唯一来源是 migrations/*.sql；这里是供查询使用的类型描述，migrate.db.test.ts 核对列名一致。

const at = (name: string) => timestamp(name, { withTimezone: true });

export const tenants = pgTable('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull(),
  name: text('name').notNull(),
  currency: text('currency', { enum: ['CNY', 'USD'] }).notNull(),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  overdraftLimit: numeric('overdraft_limit').notNull(),
  contactName: text('contact_name').notNull().default(''),
  contactPhone: text('contact_phone').notNull().default(''),
  remark: text('remark').notNull().default(''),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const admins = pgTable('admins', {
  id: uuid('id').primaryKey().defaultRandom(),
  authUserId: text('auth_user_id')
    .notNull()
    .unique()
    .references(() => authUsers.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  lastLoginAt: at('last_login_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const portalAccounts = pgTable('portal_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().unique(),
  authUserId: text('auth_user_id')
    .notNull()
    .unique()
    .references(() => authUsers.id, { onDelete: 'restrict' }),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  lastLoginAt: at('last_login_at'),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const rateVersions = pgTable('rate_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  effectiveFrom: at('effective_from').notNull().defaultNow(),
  createdBy: uuid('created_by'),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const rateEntries = pgTable('rate_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  rateVersionId: uuid('rate_version_id').notNull(),
  prefix: text('prefix').notNull(),
  country: text('country').notNull(),
  iso: text('iso').notNull().default(''),
  description: text('description').notNull().default(''),
  rate: numeric('rate').notNull(),
});

export const adminRatePreviews = pgTable(
  'admin_rate_previews',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    payload: jsonb('payload').$type<RatePreviewPayload>().notNull(),
    expiresAt: at('expires_at').notNull(),
    consumedAt: at('consumed_at'),
  },
  (table) => [
    foreignKey({
      name: 'admin_rate_previews_tenant_id_fkey',
      columns: [table.tenantId],
      foreignColumns: [tenants.id],
    }),
    check(
      'admin_rate_previews_payload_check',
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    index('admin_rate_previews_expiry').on(table.expiresAt),
  ],
);

export const ledgerKinds = [
  'recharge',
  'credit_recharge',
  'gift',
  'adjustment',
  'call_charge',
] as const;
export type LedgerKind = (typeof ledgerKinds)[number];

export const ledgerEntries = pgTable('ledger_entries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ledgerKinds }).notNull(),
  amount: numeric('amount').notNull(),
  note: text('note').notNull().default(''),
  createdBy: uuid('created_by'),
  idempotencyKey: text('idempotency_key').notNull(),
  occurredAt: at('occurred_at').notNull().defaultNow(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const receivableSettlements = pgTable('receivable_settlements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  ledgerEntryId: uuid('ledger_entry_id').notNull(),
  entryKind: text('entry_kind', { enum: ['credit_recharge'] })
    .notNull()
    .default('credit_recharge'),
  receivedOn: date('received_on').notNull(),
  note: text('note').notNull().default(''),
  confirmedBy: uuid('confirmed_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const receivableSettlementReversals = pgTable(
  'receivable_settlement_reversals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    settlementId: uuid('settlement_id').notNull(),
    reason: text('reason').notNull(),
    reversedBy: uuid('reversed_by').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
);

export const receivableVoids = pgTable('receivable_voids', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  ledgerEntryId: uuid('ledger_entry_id').notNull(),
  entryKind: text('entry_kind', { enum: ['credit_recharge'] })
    .notNull()
    .default('credit_recharge'),
  adjustmentLedgerEntryId: uuid('adjustment_ledger_entry_id').notNull(),
  adjustmentKind: text('adjustment_kind', { enum: ['adjustment'] })
    .notNull()
    .default('adjustment'),
  reason: text('reason').notNull(),
  voidedBy: uuid('voided_by').notNull(),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const tenantBalances = pgTable('tenant_balances', {
  tenantId: uuid('tenant_id').primaryKey(),
  balance: numeric('balance').notNull(),
  updatedAt: at('updated_at').notNull(),
});

export const receivables = pgView('receivables', {
  ledgerEntryId: uuid('ledger_entry_id').notNull(),
  tenantId: uuid('tenant_id').notNull(),
  amount: numeric('amount').notNull(),
  note: text('note').notNull(),
  createdBy: uuid('created_by'),
  createdAt: at('created_at').notNull(),
  status: text('status', { enum: ['pending', 'received', 'voided'] }).notNull(),
  receivedOn: date('received_on'),
  confirmedBy: uuid('confirmed_by'),
  settlementId: uuid('settlement_id'),
  settlementNote: text('settlement_note'),
  latestSettlementId: uuid('latest_settlement_id'),
  voidId: uuid('void_id'),
  adjustmentLedgerEntryId: uuid('adjustment_ledger_entry_id'),
  voidReason: text('void_reason'),
  voidedBy: uuid('voided_by'),
  voidedAt: at('voided_at'),
}).existing();

export const balanceDiscrepancies = pgView('balance_discrepancies', {
  tenantId: uuid('tenant_id').notNull(),
  code: text('code').notNull(),
  cachedBalance: numeric('cached_balance'),
  ledgerTotal: numeric('ledger_total').notNull(),
}).existing();

export const callUuids = pgTable('call_uuids', {
  callUuid: uuid('call_uuid').primaryKey(),
  /** null：未归属话单登记的 UUID，尚未被任何租户的话单认领。 */
  tenantId: uuid('tenant_id'),
  startedAt: at('started_at').notNull(),
});

export const cdrs = pgTable(
  'cdrs',
  {
    tenantId: uuid('tenant_id').notNull(),
    callUuid: uuid('call_uuid').notNull(),
    startedAt: at('started_at').notNull(),
    answeredAt: at('answered_at'),
    endedAt: at('ended_at').notNull(),
    caller: text('caller').notNull(),
    callee: text('callee').notNull(),
    billingNumber: text('billing_number').notNull(),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    billedMinutes: numeric('billed_minutes').notNull().default('0'),
    matchedPrefix: text('matched_prefix'),
    country: text('country'),
    iso: text('iso'),
    description: text('description'),
    rate: numeric('rate'),
    charge: numeric('charge').notNull().default('0'),
    hangupCause: text('hangup_cause').notNull().default(''),
    unverified: boolean('unverified').notNull().default(false),
    reconcileAttempts: integer('reconcile_attempts').notNull().default(0),
    reconciledAt: at('reconciled_at'),
    reconcileAlerted: boolean('reconcile_alerted').notNull().default(false),
    receivedAt: at('received_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.callUuid, table.startedAt] })],
);

export const rawCdrs = pgTable(
  'raw_cdrs',
  {
    id: uuid('id').notNull().defaultRandom(),
    tenantId: uuid('tenant_id'),
    callUuid: uuid('call_uuid'),
    body: text('body').notNull(),
    payload: jsonb('payload').generatedAlwaysAs(sql`jsonb_or_null(body)`),
    receivedAt: at('received_at').notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.id, table.receivedAt] })],
);

export const unassignedCdrs = pgTable('unassigned_cdrs', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantTag: text('tenant_tag').notNull().default(''),
  callUuid: uuid('call_uuid'),
  rawId: uuid('raw_id'),
  rawReceivedAt: at('raw_received_at'),
  reason: text('reason').notNull(),
  startedAt: at('started_at'),
  answeredAt: at('answered_at'),
  endedAt: at('ended_at'),
  caller: text('caller').notNull(),
  callee: text('callee').notNull(),
  billingNumber: text('billing_number'),
  durationSeconds: integer('duration_seconds').notNull().default(0),
  status: text('status', { enum: ['pending', 'ignored', 'assigned'] })
    .notNull()
    .default('pending'),
  ignoreReason: text('ignore_reason'),
  assignedTenantId: uuid('assigned_tenant_id'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: at('resolved_at'),
  receivedAt: at('received_at').notNull().defaultNow(),
});

export const monthlyStatements = pgTable('monthly_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  month: date('month').notNull(),
  openingBalance: numeric('opening_balance').notNull(),
  recharge: numeric('recharge').notNull(),
  gift: numeric('gift').notNull(),
  adjustment: numeric('adjustment').notNull(),
  callCharges: numeric('call_charges').notNull(),
  closingBalance: numeric('closing_balance').notNull(),
  callMinutes: numeric('call_minutes').notNull(),
  detailsDeleted: boolean('details_deleted').notNull().default(false),
  generatedAt: at('generated_at').notNull().defaultNow(),
});

export const operationLogs = pgTable('operation_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').notNull(),
  tenantId: uuid('tenant_id'),
  action: text('action').notNull(),
  target: text('target').notNull().default(''),
  details: jsonb('details').notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const systemAlerts = pgTable('system_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  kind: text('kind', {
    enum: ['auth_timeout', 'cdr_failed', 'email_failed', 'partition_failed'],
  }).notNull(),
  description: text('description').notNull(),
  startedAt: at('started_at').notNull().defaultNow(),
  recoveredAt: at('recovered_at'),
  affectedCalls: integer('affected_calls').notNull().default(0),
});

export const balanceAlertSettings = pgTable('balance_alert_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  threshold: numeric('threshold').notNull(),
  emails: text('emails').array().notNull().default([]),
});

export const balanceAlertDeliveries = pgTable('balance_alert_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['low_balance', 'suspended'] }).notNull(),
  balance: numeric('balance').notNull(),
  recipients: text('recipients').array().notNull(),
  sentAt: at('sent_at').notNull().defaultNow(),
});
