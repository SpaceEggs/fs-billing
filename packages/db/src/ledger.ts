import { and, eq } from 'drizzle-orm';
import { decimal, type Currency, type Money } from '@fs-billing/rating';
import type { Tx } from './client.js';
import { ledgerEntries, type LedgerKind } from './schema.js';

export interface TenantRef<C extends Currency> {
  readonly id: string;
  readonly currency: C;
}

export type LedgerEntry = typeof ledgerEntries.$inferSelect;

/**
 * 符号与必填规则由数据库检查约束 ledger_entries_kind_shape 保证。
 * 发生时间：通话扣费为接通时间（occurredAt），人工操作即写入时间（createdAt，默认数据库 now()）。
 */
export type LedgerEntryInput<C extends Currency> = {
  readonly amount: Money<C>;
  readonly note: string;
  readonly idempotencyKey: string;
  readonly createdAt?: Date;
} & (
  | {
      readonly kind: Exclude<LedgerKind, 'call_charge'>;
      readonly adminId: string;
    }
  | { readonly kind: 'call_charge'; readonly occurredAt: Date }
);

export function callChargeKey(callUuid: string): string {
  return `call:${callUuid}`;
}

/**
 * 追加一笔流水。幂等：同一租户同一幂等键只记一次，重试返回已有记录；
 * 键相同但类型或金额不同说明调用方出错，抛出异常。
 */
export async function appendLedgerEntry<C extends Currency>(
  tx: Tx,
  tenant: TenantRef<C>,
  entry: LedgerEntryInput<NoInfer<C>>,
): Promise<LedgerEntry> {
  const [inserted] = await tx
    .insert(ledgerEntries)
    .values({
      tenantId: tenant.id,
      kind: entry.kind,
      amount: entry.amount.value.toFixed(),
      note: entry.note,
      createdBy: entry.kind === 'call_charge' ? null : entry.adminId,
      idempotencyKey: entry.idempotencyKey,
      ...(entry.createdAt && {
        createdAt: entry.createdAt,
        occurredAt: entry.createdAt,
      }),
      ...(entry.kind === 'call_charge' && { occurredAt: entry.occurredAt }),
    })
    .onConflictDoNothing({
      target: [ledgerEntries.tenantId, ledgerEntries.idempotencyKey],
    })
    .returning();
  if (inserted) return inserted;

  const [existing] = await tx
    .select()
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, tenant.id),
        eq(ledgerEntries.idempotencyKey, entry.idempotencyKey),
      ),
    );
  if (
    !existing ||
    existing.kind !== entry.kind ||
    !decimal(existing.amount).eq(entry.amount.value)
  ) {
    throw new Error(`幂等键 ${entry.idempotencyKey} 已用于另一笔流水`);
  }
  return existing;
}
