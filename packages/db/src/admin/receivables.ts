import { randomUUID } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import {
  adminConfirmPaymentRequestSchema,
  adminReversePaymentRequestSchema,
  adminVoidReceivableRequestSchema,
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
import { canonicalTenantId } from '../ledger.js';
import {
  ledgerEntries,
  receivables,
  receivableSettlements,
  receivableSettlementReversals,
  receivableVoids,
  tenants,
} from '../schema.js';
import { writeAudit } from './audit.js';
import { AdminServiceError } from './errors.js';

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
