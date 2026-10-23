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
  unique,
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

export const unassignedCdrStatuses = [
  'pending',
  'ignored',
  'assigned',
  'superseded',
] as const;
export type UnassignedCdrStatus = (typeof unassignedCdrStatuses)[number];

/** 分配批次（只增）：一次分配一行，幂等键在租户内唯一。 */
export const unassignedAssignments = pgTable(
  'unassigned_assignments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    /** 按分组选择时的标签（空串表示标签为空的分组），按勾选时为空。 */
    sourceTag: text('source_tag'),
    /** 请求（选择 + 预览数字）的摘要，同键重放时核对。 */
    requestDigest: text('request_digest').notNull(),
    assignedCount: integer('assigned_count').notNull(),
    noRateCount: integer('no_rate_count').notNull(),
    blockedCount: integer('blocked_count').notNull(),
    chargeTotal: numeric('charge_total').notNull(),
    balanceBefore: numeric('balance_before').notNull(),
    balanceAfter: numeric('balance_after').notNull(),
    /** 扣费流水落入的北京月（1 日）。 */
    affectedMonths: date('affected_months').array().notNull(),
    auditId: uuid('audit_id').notNull(),
    createdAt: at('created_at').notNull().defaultNow(),
  },
  (table) => [
    unique('unassigned_assignments_tenant_idempotency_key').on(
      table.tenantId,
      table.idempotencyKey,
    ),
  ],
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
  status: text('status', { enum: unassignedCdrStatuses })
    .notNull()
    .default('pending'),
  ignoreReason: text('ignore_reason'),
  assignedTenantId: uuid('assigned_tenant_id'),
  resolvedBy: uuid('resolved_by'),
  resolvedAt: at('resolved_at'),
  receivedAt: at('received_at').notNull().defaultNow(),
  hangupCause: text('hangup_cause').notNull().default(''),
  unverified: boolean('unverified').notNull().default(false),
  /** 无效推送去重键：原文 UTF-8 字节的 SHA-256 十六进制。 */
  rawSha256: text('raw_sha256'),
  pushCount: integer('push_count').notNull().default(1),
  lastPushedAt: at('last_pushed_at'),
  /** 校验失败的原文里尽力解析出的 variables.uuid。 */
  candidateCallUuid: uuid('candidate_call_uuid'),
  /** 状态 superseded 时，修正重推成功的通话 UUID。 */
  supersededByCallUuid: uuid('superseded_by_call_uuid'),
  /** 状态 assigned 时所属的分配批次。 */
  assignmentId: uuid('assignment_id'),
});

export const statementReconcileStatuses = [
  'unchecked',
  'ok',
  'stale',
  'inconsistent',
] as const;
export type StatementReconcileStatus =
  (typeof statementReconcileStatuses)[number];

export const monthlyStatements = pgTable('monthly_statements', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  /** 该月 1 日。 */
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
  calls: integer('calls').notNull().default(0),
  version: integer('version').notNull().default(1),
  firstGeneratedAt: at('first_generated_at').notNull().defaultNow(),
  /** 空表示定时任务。 */
  generatedBy: uuid('generated_by'),
  breakdownGap: numeric('breakdown_gap').notNull().default('0'),
  reconcileStatus: text('reconcile_status', {
    enum: statementReconcileStatuses,
  })
    .notNull()
    .default('unchecked'),
  reconciledAt: at('reconciled_at'),
  reconcileDiff: numeric('reconcile_diff'),
  /** 删除话单的时间、操作人与条数；三列同为空或同非空，只在 details_deleted 置真的同一次更新里写入。 */
  detailsDeletedAt: at('details_deleted_at'),
  detailsDeletedBy: uuid('details_deleted_by'),
  detailsDeletedCount: integer('details_deleted_count'),
});

export const monthlyStatementCountries = pgTable(
  'monthly_statement_countries',
  {
    statementId: uuid('statement_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    version: integer('version').notNull(),
    country: text('country').notNull(),
    calls: integer('calls').notNull(),
    minutes: numeric('minutes').notNull(),
    charge: numeric('charge').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.statementId, table.version, table.country] }),
  ],
);

export const monthlyStatementDays = pgTable(
  'monthly_statement_days',
  {
    statementId: uuid('statement_id').notNull(),
    tenantId: uuid('tenant_id').notNull(),
    version: integer('version').notNull(),
    day: date('day').notNull(),
    calls: integer('calls').notNull(),
    minutes: numeric('minutes').notNull(),
    charge: numeric('charge').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.statementId, table.version, table.day] }),
  ],
);

export const operationLogs = pgTable('operation_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 与 actorLabel 恰有其一：没有管理员的事件（auth:bootstrap 等）只有 actorLabel。 */
  adminId: uuid('admin_id'),
  actorLabel: text('actor_label'),
  tenantId: uuid('tenant_id'),
  action: text('action').notNull(),
  target: text('target').notNull().default(''),
  details: jsonb('details').notNull().default({}),
  createdAt: at('created_at').notNull().defaultNow(),
});

export const systemAlertKinds = [
  'auth_timeout',
  'cdr_failed',
  'email_failed',
  'partition_failed',
  'statement_mismatch',
  'audit_failed',
  'raw_archive_failed',
] as const;
export type SystemAlertKind = (typeof systemAlertKinds)[number];

export const systemAlerts = pgTable('system_alerts', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id'),
  kind: text('kind', { enum: systemAlertKinds }).notNull(),
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
