import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { decimal, money } from '@fs-billing/rating';
import {
  adminAmountRequestSchemas,
  type AdminAmountRequestSchemas,
  adminLedgerQuerySchema,
  adminLedgerResponseSchema,
  type AdminBalanceOperationRequest,
  type AdminBalanceOperationResponse,
  type AdminLedgerEntry,
  type AdminLedgerQuery,
  type AdminLedgerResponse,
  type AuditPayload,
} from '@fs-billing/shared';
import { withAdmin, lockTenants, type Db, type Tx } from '../client.js';
import { appendLedgerEntry } from '../ledger.js';
import { mergedLedgerSql } from '../ledger-merge.js';
import { NotFoundError } from '../errors.js';
import {
  admins,
  ledgerEntries,
  operationLogs,
  receivables,
  tenantBalances,
} from '../schema.js';
import { readTenantCore } from './tenants.js';
import { writeAudit } from './audit.js';
import { AdminServiceError } from './errors.js';

const kinds = {
  topup: 'recharge',
  credit_topup: 'credit_recharge',
  gift: 'gift',
  adjustment: 'adjustment',
} as const;
const actions = {
  topup: 'balance_topup',
  credit_topup: 'balance_credit_topup',
  gift: 'balance_gift',
  adjustment: 'balance_adjustment',
} as const;
function ledgerRows(tx: Tx) {
  return tx
    .select({
      id: ledgerEntries.id,
      kind: ledgerEntries.kind,
      amount: ledgerEntries.amount,
      note: ledgerEntries.note,
      paymentStatus: receivables.status,
      actorId: admins.id,
      actorName: admins.name,
      occurredAt: ledgerEntries.occurredAt,
    })
    .from(ledgerEntries)
    .leftJoin(receivables, eq(receivables.ledgerEntryId, ledgerEntries.id))
    .leftJoin(admins, eq(admins.id, ledgerEntries.createdBy));
}
function project(
  row: Awaited<ReturnType<typeof ledgerRows>>[number],
  balanceAfter: string,
): AdminLedgerEntry {
  return {
    id: row.id,
    kind: row.kind,
    amount: row.amount,
    balanceAfter,
    note: row.note,
    noteVisibility: row.kind === 'credit_recharge' ? 'admin' : 'customer',
    paymentStatus: row.paymentStatus,
    actor:
      row.actorId !== null && row.actorName !== null
        ? { id: row.actorId, name: row.actorName }
        : null,
    occurredAt: row.occurredAt.toISOString(),
  };
}
export function listTenantLedger({
  db,
  tenantId,
  query,
}: {
  db: Db | Tx;
  tenantId: string;
  query: AdminLedgerQuery;
}): Promise<AdminLedgerResponse> {
  const input = adminLedgerQuerySchema.parse(query);
  return withAdmin(db, async (tx) => {
    await tx.execute(sql`set local jit = off`);
    const { rows } = await tx.execute<{ ledger: unknown }>(
      mergedLedgerSql({
        tenantId,
        query: input,
        pageSize: input.pageSize,
        audience: 'admin',
      }),
    );
    if (!rows[0]) throw new NotFoundError('租户不存在');
    return adminLedgerResponseSchema.parse(rows[0].ledger);
  });
}
export async function operateBalance({
  db,
  actor,
  tenantId,
  request,
  amountRequests = adminAmountRequestSchemas,
}: {
  db: Db | Tx;
  actor: AuditPayload['actor'];
  tenantId: string;
  request: AdminBalanceOperationRequest;
  amountRequests?: AdminAmountRequestSchemas;
}): Promise<AdminBalanceOperationResponse> {
  const input = amountRequests.balance.parse(request);
  const note =
    input.kind === 'credit_topup'
      ? input.internalNote
      : input.kind === 'adjustment'
        ? input.reason
        : input.note;
  return withAdmin(db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    const tenant = await readTenantCore(tx, tenantId);
    const [existing] = await tx
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenant.id),
          eq(ledgerEntries.idempotencyKey, input.idempotencyKey),
        ),
      );
    let auditId: string;
    let entryId: string;
    if (existing) {
      if (existing.createdBy !== actor.id.toLowerCase())
        throw new AdminServiceError(
          'IDEMPOTENCY_CONFLICT',
          '幂等键已由其他管理员使用',
        );
      if (
        input.currency !== tenant.currency ||
        existing.kind !== kinds[input.kind] ||
        !decimal(existing.amount).eq(input.amount) ||
        existing.note !== note
      )
        throw new AdminServiceError('IDEMPOTENCY_CONFLICT', '幂等键载荷不符');
      const [audit] = await tx
        .select({ id: operationLogs.id })
        .from(operationLogs)
        .where(
          and(
            eq(operationLogs.tenantId, tenant.id),
            eq(operationLogs.target, existing.id),
            eq(operationLogs.action, actions[input.kind]),
          ),
        );
      if (!audit)
        throw new AdminServiceError(
          'IDEMPOTENCY_CONFLICT',
          '已有流水缺少人工操作审计',
        );
      auditId = audit.id;
      entryId = existing.id;
    } else {
      if (input.currency !== tenant.currency)
        throw new AdminServiceError('CURRENCY_MISMATCH', '租户币种不符');
      const entry = await appendLedgerEntry(
        tx,
        { id: tenant.id, currency: tenant.currency },
        {
          kind: kinds[input.kind],
          amount: money(tenant.currency, input.amount),
          note,
          adminId: actor.id,
          idempotencyKey: input.idempotencyKey,
        },
      );
      entryId = entry.id;
      auditId = randomUUID();
      const envelope = {
        id: auditId,
        actor,
        occurredAt: entry.createdAt.toISOString(),
        tenantId: tenant.id,
        target: { kind: 'ledger_entry' as const, id: entry.id },
      };
      const content = {
        summary: '人工余额操作',
        changes: [],
        ledgerEntryId: entry.id,
        amount: decimal(input.amount).toFixed(),
        currency: tenant.currency,
      };
      if (input.kind === 'adjustment')
        await writeAudit(tx, {
          ...envelope,
          action: 'balance_adjustment',
          content: { ...content, reason: input.reason },
        });
      else
        await writeAudit(tx, {
          ...envelope,
          action: actions[input.kind],
          content,
        });
    }
    const [row] = await ledgerRows(tx).where(eq(ledgerEntries.id, entryId));
    const [current] = await tx
      .select({ balance: tenantBalances.balance })
      .from(tenantBalances)
      .where(eq(tenantBalances.tenantId, tenant.id));
    if (!row || !current) throw new Error('余额流水写入失败');
    const { rows: balances } = await tx.execute<{ amount: string }>(sql`
      select coalesce(sum(amount), 0)::text as amount from ledger_entries
      where tenant_id = ${tenant.id}::uuid
        and (occurred_at, id) <= (select occurred_at, id from ledger_entries where id = ${row.id}::uuid and tenant_id = ${tenant.id}::uuid)
    `);
    const balanceAfter = balances[0]?.amount;
    if (balanceAfter === undefined) throw new Error('余额流水读取失败');
    return {
      auditId,
      currency: tenant.currency,
      entry: project(row, balanceAfter),
      balance: current.balance,
    };
  });
}
