import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql, desc, or, getViewSelectedFields } from 'drizzle-orm';
import {
  adminConfirmPaymentRequestSchema,
  adminReversePaymentRequestSchema,
  adminVoidReceivableRequestSchema,
  adminReceivableSchema,
  adminReceivablesQuerySchema,
  type AdminReceivablesQuery,
  type AdminReceivablesResponse,
  type AdminConfirmPaymentRequest,
  type AdminConfirmPaymentResponse,
  type AdminReversePaymentRequest,
  type AdminReversePaymentResponse,
  type AdminVoidReceivableRequest,
  type AdminVoidReceivableResponse,
  type AuditPayload,
} from '@fs-billing/shared';
import { decimal } from '@fs-billing/rating';
import { lockTenants, withAdmin, type Db, type Tx } from '../client.js';
import { likeContains } from './like.js';
import { canonicalTenantId } from '../ledger.js';
import {
  ledgerEntries,
  receivables,
  receivableSettlements,
  receivableSettlementReversals,
  receivableVoids,
  tenants,
  admins,
} from '../schema.js';
import { writeAudit } from './audit.js';
import { AdminServiceError } from './errors.js';

export function listReceivables({
  db,
  query,
}: {
  db: Db | Tx;
  query: AdminReceivablesQuery;
}): Promise<AdminReceivablesResponse> {
  const input = adminReceivablesQuerySchema.parse(query);
  return withAdmin(db, async (tx) => {
    const filter = and(
      eq(receivables.status, input.status),
      input.currency ? eq(tenants.currency, input.currency) : undefined,
      input.search
        ? or(
            sql`${tenants.code} ilike ${likeContains(input.search)} escape '\\'`,
            sql`${tenants.name} ilike ${likeContains(input.search)} escape '\\'`,
          )
        : undefined,
    );
    const [aggregate] = await tx
      .select({
        total: sql<number>`count(*)::int`,
        CNY: sql<string>`coalesce(sum(${receivables.amount}) filter (where ${tenants.currency} = 'CNY'), 0)::text`,
        USD: sql<string>`coalesce(sum(${receivables.amount}) filter (where ${tenants.currency} = 'USD'), 0)::text`,
      })
      .from(receivables)
      .innerJoin(tenants, eq(tenants.id, receivables.tenantId))
      .where(filter);
    const rows = await tx
      .select({
        ...getViewSelectedFields(receivables),
        tenant: {
          id: tenants.id,
          code: tenants.code,
          name: tenants.name,
          currency: tenants.currency,
        },
        actor: { id: admins.id, name: admins.name },
        ageDays: sql<number>`greatest(0, (clock_timestamp() at time zone 'Asia/Shanghai')::date - (${receivables.createdAt} at time zone 'Asia/Shanghai')::date)::int`,
      })
      .from(receivables)
      .innerJoin(tenants, eq(tenants.id, receivables.tenantId))
      .innerJoin(admins, eq(admins.id, receivables.createdBy))
      .where(filter)
      .orderBy(desc(receivables.createdAt), desc(receivables.ledgerEntryId))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize);
    return {
      items: rows.map((row) =>
        adminReceivableSchema.parse({
          ledgerEntryId: row.ledgerEntryId,
          latestSettlementId: row.latestSettlementId,
          tenant: row.tenant,
          amount: row.amount,
          internalNote: row.note,
          createdAt: row.createdAt.toISOString(),
          actor: row.actor,
          ageDays: row.ageDays,
          overdue: row.status === 'pending' && row.ageDays > 30,
          payment:
            row.status === 'received'
              ? {
                  status: 'received',
                  settlementId: row.settlementId,
                  receivedOn: row.receivedOn,
                  note: row.settlementNote,
                  confirmedBy: row.confirmedBy,
                }
              : row.status === 'voided'
                ? {
                    status: 'voided',
                    voidId: row.voidId,
                    adjustmentLedgerEntryId: row.adjustmentLedgerEntryId,
                    reason: row.voidReason,
                    voidedBy: row.voidedBy,
                    voidedAt: row.voidedAt?.toISOString(),
                  }
                : { status: 'pending' },
        }),
      ),
      totals: { CNY: aggregate?.CNY ?? '0', USD: aggregate?.USD ?? '0' },
      pagination: {
        page: input.page,
        pageSize: input.pageSize,
        total: aggregate?.total ?? 0,
      },
    };
  });
}

type ReceivableInput<Request> = {
  db: Db | Tx;
  actor: AuditPayload['actor'];
  ledgerEntryId: string;
  request: Request;
};

async function lockedReceivable(tx: Tx, ledgerEntryId: string) {
  const [credit] = await tx
    .select({ tenantId: ledgerEntries.tenantId })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.id, ledgerEntryId),
        eq(ledgerEntries.kind, 'credit_recharge'),
      ),
    );
  if (!credit) throw new AdminServiceError('NOT_FOUND', '应收流水不存在');
  await lockTenants(tx, [credit.tenantId]);
  const [entry] = await tx
    .select({
      ledgerEntryId: receivables.ledgerEntryId,
      tenantId: receivables.tenantId,
      amount: receivables.amount,
      currency: tenants.currency,
      createdAt: receivables.createdAt,
      status: receivables.status,
      latestSettlementId: receivables.latestSettlementId,
      settlementId: receivables.settlementId,
      creditDate: sql<string>`(${receivables.createdAt} at time zone 'Asia/Shanghai')::date::text`,
      today: sql<string>`(clock_timestamp() at time zone 'Asia/Shanghai')::date::text`,
    })
    .from(receivables)
    .innerJoin(tenants, eq(tenants.id, receivables.tenantId))
    .where(eq(receivables.ledgerEntryId, ledgerEntryId));
  if (!entry) throw new AdminServiceError('NOT_FOUND', '应收流水不存在');
  if (entry.status === 'voided')
    throw new AdminServiceError('RECEIVABLE_VOIDED', '应收已作废');
  return entry;
}

export async function confirmPayment({
  db,
  actor,
  ledgerEntryId,
  request,
}: ReceivableInput<AdminConfirmPaymentRequest>): Promise<AdminConfirmPaymentResponse> {
  const input = adminConfirmPaymentRequestSchema.parse(request);
  return withAdmin(db, async (tx) => {
    const entry = await lockedReceivable(tx, ledgerEntryId);
    if (entry.status === 'received')
      throw new AdminServiceError('ALREADY_RECEIVED', '应收已确认收款');
    const expected =
      input.expectedLatestSettlementId === null
        ? null
        : canonicalTenantId(input.expectedLatestSettlementId);
    if (entry.latestSettlementId !== expected)
      throw new AdminServiceError(
        'SETTLEMENT_CONFLICT',
        '收款确认已变化，请刷新',
      );
    if (input.receivedOn < entry.creditDate || input.receivedOn > entry.today)
      throw new AdminServiceError(
        'VALIDATION_ERROR',
        '收款日期须在赊账日期与当前北京时间日期之间',
      );
    const [settlement] = await tx
      .insert(receivableSettlements)
      .values({
        tenantId: entry.tenantId,
        ledgerEntryId: entry.ledgerEntryId,
        receivedOn: input.receivedOn,
        note: input.note,
        confirmedBy: actor.id,
      })
      .returning();
    if (!settlement) throw new Error('收款确认写入失败');
    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor,
      occurredAt: settlement.createdAt.toISOString(),
      tenantId: entry.tenantId,
      target: { kind: 'receivable', id: entry.ledgerEntryId },
      action: 'receivable_confirm',
      content: {
        summary: '确认全额收款',
        changes: [],
        ledgerEntryId: entry.ledgerEntryId,
        settlementId: settlement.id,
        amount: decimal(entry.amount).toFixed(),
        currency: entry.currency,
        receivedOn: input.receivedOn,
      },
    });
    return {
      auditId,
      ledgerEntryId: entry.ledgerEntryId,
      settlementId: settlement.id,
      receivedOn: input.receivedOn,
    };
  });
}

export async function reversePayment({
  db,
  actor,
  ledgerEntryId,
  request,
}: ReceivableInput<AdminReversePaymentRequest>): Promise<AdminReversePaymentResponse> {
  const input = adminReversePaymentRequestSchema.parse(request);
  return withAdmin(db, async (tx) => {
    const entry = await lockedReceivable(tx, ledgerEntryId);
    if (
      entry.status !== 'received' ||
      entry.settlementId !== canonicalTenantId(input.settlementId)
    )
      throw new AdminServiceError(
        'SETTLEMENT_CONFLICT',
        '收款确认已变化，请刷新',
      );
    const [reversal] = await tx
      .insert(receivableSettlementReversals)
      .values({
        tenantId: entry.tenantId,
        settlementId: entry.settlementId,
        reason: input.reason,
        reversedBy: actor.id,
      })
      .returning();
    if (!reversal) throw new Error('收款撤销写入失败');
    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor,
      occurredAt: reversal.createdAt.toISOString(),
      tenantId: entry.tenantId,
      target: { kind: 'receivable', id: entry.ledgerEntryId },
      action: 'receivable_payment_reverse',
      content: {
        summary: '撤销收款确认',
        changes: [],
        ledgerEntryId: entry.ledgerEntryId,
        settlementId: entry.settlementId,
        reversalId: reversal.id,
        reason: input.reason,
        amount: decimal(entry.amount).toFixed(),
        currency: entry.currency,
      },
    });
    return {
      auditId,
      ledgerEntryId: entry.ledgerEntryId,
      settlementId: entry.settlementId,
      reversalId: reversal.id,
    };
  });
}

export async function voidReceivable({
  db,
  actor,
  ledgerEntryId,
  request,
}: ReceivableInput<AdminVoidReceivableRequest>): Promise<AdminVoidReceivableResponse> {
  const input = adminVoidReceivableRequestSchema.parse(request);
  return withAdmin(db, async (tx) => {
    const entry = await lockedReceivable(tx, ledgerEntryId);
    if (entry.status === 'received')
      throw new AdminServiceError('ALREADY_RECEIVED', '须先撤销收款确认');
    const [adjustment] = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.id, input.adjustmentLedgerEntryId),
          eq(ledgerEntries.tenantId, entry.tenantId),
          eq(ledgerEntries.kind, 'adjustment'),
          sql`${ledgerEntries.createdAt} > (select created_at from ledger_entries where id = ${entry.ledgerEntryId})`,
        ),
      );
    if (
      !adjustment ||
      !decimal(adjustment.amount).eq(decimal(entry.amount).negated())
    )
      throw new AdminServiceError(
        'RECEIVABLE_REVERSAL_MISMATCH',
        '冲正流水不匹配或不晚于赊账',
      );
    const [used] = await tx
      .select({ id: receivableVoids.id })
      .from(receivableVoids)
      .where(eq(receivableVoids.adjustmentLedgerEntryId, adjustment.id));
    const [counterAdjustment] = await tx
      .select({ id: ledgerEntries.id })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, entry.tenantId),
          eq(ledgerEntries.kind, 'adjustment'),
          ne(ledgerEntries.id, adjustment.id),
          sql`${ledgerEntries.createdAt} >= (select created_at from ledger_entries where id = ${adjustment.id})`,
          eq(
            ledgerEntries.amount,
            decimal(adjustment.amount).negated().toFixed(),
          ),
        ),
      );
    if (used || counterAdjustment)
      throw new AdminServiceError(
        'RECEIVABLE_REVERSAL_MISMATCH',
        '冲正流水已复用或存在后续反向调账',
      );
    const [voided] = await tx
      .insert(receivableVoids)
      .values({
        tenantId: entry.tenantId,
        ledgerEntryId: entry.ledgerEntryId,
        adjustmentLedgerEntryId: adjustment.id,
        reason: input.reason,
        voidedBy: actor.id,
      })
      .returning();
    if (!voided) throw new Error('应收作废写入失败');
    const auditId = randomUUID();
    await writeAudit(tx, {
      id: auditId,
      actor,
      occurredAt: voided.createdAt.toISOString(),
      tenantId: entry.tenantId,
      target: { kind: 'receivable', id: entry.ledgerEntryId },
      action: 'receivable_void',
      content: {
        summary: '作废已冲正应收',
        changes: [],
        ledgerEntryId: entry.ledgerEntryId,
        voidId: voided.id,
        adjustmentLedgerEntryId: adjustment.id,
        reason: input.reason,
        amount: decimal(entry.amount).toFixed(),
        currency: entry.currency,
      },
    });
    return { auditId, ledgerEntryId: entry.ledgerEntryId, voidId: voided.id };
  });
}
