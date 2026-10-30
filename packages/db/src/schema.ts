import { sql } from 'drizzle-orm';
import { authUsers } from './auth-schema.js';
import type { RatePreviewPayload } from './admin/rate-preview.js';
import type {
  ArchiveChunk,
  ArchiveFingerprint,
  ArchiveState,
} from './raw-archive/types.js';
import {
  bigint,
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

/** 原始 JSON 归档清单：每个北京月一行，阶段由 verified_at / detached_at / dropped_at 决定。 */
export const rawCdrArchives = pgTable('raw_cdr_archives', {
  /** 该月 1 日，对应分区 raw_cdrs_YYYY_MM。 */
  month: date('month').primaryKey(),
  state: text('state').$type<ArchiveState>().notNull(),
  fileKey: text('file_key'),
  rows: bigint('rows', { mode: 'number' }),
  bodyBytes: bigint('body_bytes', { mode: 'number' }),
  fileBytes: bigint('file_bytes', { mode: 'number' }),
  fileSha256: text('file_sha256'),
  rowsDigest: text('rows_digest'),
  dbFingerprint: jsonb('db_fingerprint').$type<ArchiveFingerprint>(),
  chunks: jsonb('chunks').$type<ArchiveChunk[]>(),
  attempts: integer('attempts').notNull().default(0),
  lastError: text('last_error'),
  createdAt: at('created_at').notNull().defaultNow(),
  verifiedAt: at('verified_at'),
  detachedAt: at('detached_at'),
  droppedAt: at('dropped_at'),
  restoredAt: at('restored_at'),
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
  /** 告警身份：同一 kind 内同一时刻只有一条未恢复（局部唯一索引）。旧行可空，不参与合并与自动恢复。 */
  subjectKey: text('subject_key'),
  /** 最近一次事件的数据库时间；静默窗口恢复按它判断。 */
  lastSeenAt: at('last_seen_at').notNull().defaultNow(),
  /** 事件次数；affected_calls 仍是影响的通话数。 */
  occurrences: integer('occurrences').notNull().default(1),
  /** 新开时按 kind 策略定下是否发邮件；之后改策略不回头影响旧告警。 */
  notify: boolean('notify').notNull().default(false),
  notifiedStartAt: at('notified_start_at'),
  lastDigestAt: at('last_digest_at'),
  digestCursor: integer('digest_cursor').notNull().default(0),
  notifiedRecoveredAt: at('notified_recovered_at'),
});

/** 故障告警设置（阶段 9）：单行表（id 恒为 true）。空的 recipients 表示发给所有 active 管理员的登录邮箱。 */
export const alertSettings = pgTable('alert_settings', {
  id: boolean('id').primaryKey().default(true),
  recipients: text('recipients').array().notNull().default([]),
  digestMinutes: integer('digest_minutes').notNull().default(15),
  version: integer('version').notNull().default(1),
  updatedAt: at('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

export const balanceAlertSettings = pgTable('balance_alert_settings', {
  tenantId: uuid('tenant_id').primaryKey(),
  threshold: numeric('threshold').notNull(),
  emails: text('emails').array().notNull().default([]),
});

/**
 * 余额通知状态（阶段 9）：每个租户一行，由 tenant_balances 的触发器与 sync_balance_notice_state 维护，
 * 应用代码只读。`lowActive` / `suspendedActive` 为真表示这一轮已通知过，回到线上之前不再发（滞回）；
 * `*Seq` 是已入队的通知序号，拼发件箱幂等键 `balance_low:<租户>:<序号>`。
 */
export const balanceNoticeState = pgTable('balance_notice_state', {
  tenantId: uuid('tenant_id').primaryKey(),
  lowActive: boolean('low_active').notNull().default(false),
  lowSeq: integer('low_seq').notNull().default(0),
  suspendedActive: boolean('suspended_active').notNull().default(false),
  suspendedSeq: integer('suspended_seq').notNull().default(0),
  suspendedAt: at('suspended_at'),
  updatedAt: at('updated_at').notNull().defaultNow(),
});

export const balanceAlertDeliveries = pgTable('balance_alert_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  kind: text('kind', { enum: ['low_balance', 'suspended'] }).notNull(),
  balance: numeric('balance').notNull(),
  recipients: text('recipients').array().notNull(),
  sentAt: at('sent_at').notNull().defaultNow(),
  /** 实际发出这条通知的发件箱行（分发器在标记 sent 的同一事务里插入）；唯一，保证同一封邮件只记一次。 */
  outboxId: uuid('outbox_id').unique(),
});

export const emailTemplates = [
  'balance_low',
  'balance_suspended',
  'alert_start',
  'alert_digest',
  'alert_recovered',
  'test',
] as const;
export type EmailTemplate = (typeof emailTemplates)[number];
export const emailOutboxStatuses = [
  'pending',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;
export type EmailOutboxStatus = (typeof emailOutboxStatuses)[number];

/** 邮件发件箱（阶段 9）：不存渲染后的正文，只存模板名和快照；收件人是入队时的快照。 */
export const emailOutbox = pgTable('email_outbox', {
  id: uuid('id').primaryKey().defaultRandom(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  template: text('template', { enum: emailTemplates }).notNull(),
  params: jsonb('params').$type<Record<string, unknown>>().notNull(),
  recipients: text('recipients').array().notNull(),
  tenantId: uuid('tenant_id'),
  status: text('status', { enum: emailOutboxStatuses }).notNull(),
  skipReason: text('skip_reason'),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: at('next_attempt_at').notNull().defaultNow(),
  /** 认领租约；进程崩溃后到期自动释放。 */
  lockedUntil: at('locked_until'),
  /** SMTP 响应码与首行，截断到 300 字符；不含收件人地址和正文。 */
  lastError: text('last_error'),
  accepted: text('accepted').array(),
  rejected: text('rejected').array(),
  createdAt: at('created_at').notNull().defaultNow(),
  sentAt: at('sent_at'),
});
