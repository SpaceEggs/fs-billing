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
 * 通话扣费的 occurredAt 是接通时间。人工操作不写时间，occurred_at 与 created_at 都取数据库 now()。
 */
export type LedgerEntryInput<C extends Currency> = {
  readonly amount: Money<C>;
  readonly note: string;
  readonly idempotencyKey: string;
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
 * 同一事务要写多个租户时用 appendLedgerEntries，它按 tenant_id 升序加锁。
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

/** 一笔流水和它所属的租户。币种必须和租户一致。 */
export type TenantLedgerWrite = {
  [C in Currency]: {
    readonly tenant: TenantRef<C>;
    readonly entry: LedgerEntryInput<C>;
  };
}[Currency];

function compareTenantId(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * 在当前事务里按 tenant_id 升序写入多笔流水，并按这个顺序返回。
 * 插入触发器会对余额行加锁，升序使两个这样的事务不会互相死锁。
 */
export async function appendLedgerEntries(
  tx: Tx,
  entries: readonly TenantLedgerWrite[],
): Promise<LedgerEntry[]> {
  const ordered = [...entries].sort((left, right) =>
    compareTenantId(left.tenant.id, right.tenant.id),
  );
  const written: LedgerEntry[] = [];
  for (const write of ordered) {
    written.push(await appendTenantLedgerEntry(tx, write));
  }
  return written;
}

function isCnyWrite(
  write: TenantLedgerWrite,
): write is Extract<TenantLedgerWrite, { tenant: TenantRef<'CNY'> }> {
  return write.tenant.currency === 'CNY';
}

async function appendTenantLedgerEntry(
  tx: Tx,
  write: TenantLedgerWrite,
): Promise<LedgerEntry> {
  if (isCnyWrite(write)) {
    return appendLedgerEntry(tx, write.tenant, write.entry);
  }
  return appendLedgerEntry(tx, write.tenant, write.entry);
}
