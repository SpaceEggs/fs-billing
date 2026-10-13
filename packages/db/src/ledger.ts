import { and, eq } from 'drizzle-orm';
import { decimal, type Currency, type Money } from '@fs-billing/rating';
import { lockTenants, type Tx } from './client.js';
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
 * 同一事务要写多个租户时，只调用一次 appendLedgerEntries。
 */
export async function appendLedgerEntry<C extends Currency>(
  tx: Tx,
  tenant: TenantRef<C>,
  entry: LedgerEntryInput<NoInfer<C>>,
): Promise<LedgerEntry> {
  const tenantId = canonicalTenantId(tenant.id);
  await lockTenants(tx, [tenantId]);
  return insertLedgerEntry(tx, tenantId, entry);
}

async function insertLedgerEntry(
  tx: Tx,
  tenantId: string,
  entry: LedgerEntryInput<Currency>,
): Promise<LedgerEntry> {
  const [inserted] = await tx
    .insert(ledgerEntries)
    .values({
      tenantId,
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
        eq(ledgerEntries.tenantId, tenantId),
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

/**
 * PostgreSQL `uuid` 输入的规范形式：小写，8-4-4-4-12。
 * 接受可选的花括号，以及每 4 个十六进制数字后的可选连字符。输出与 `uuid::text` 相同。
 * 非法输入抛出错误，不写入。
 */
export function canonicalTenantId(tenantId: string): string {
  let src = tenantId;
  let braces = false;
  if (src.startsWith('{')) {
    src = src.slice(1);
    braces = true;
  }

  const hex: string[] = [];
  let index = 0;
  for (let byte = 0; byte < 16; byte++) {
    const hi = hexNibble(src.charAt(index));
    const lo = hexNibble(src.charAt(index + 1));
    if (hi === undefined || lo === undefined) throw invalidTenantId(tenantId);
    hex.push(((hi << 4) | lo).toString(16).padStart(2, '0'));
    index += 2;
    if (src.charAt(index) === '-' && byte % 2 === 1 && byte < 15) index += 1;
  }

  if (braces) {
    if (src.charAt(index) !== '}') throw invalidTenantId(tenantId);
    index += 1;
  }
  if (index !== src.length) throw invalidTenantId(tenantId);
  const body = hex.join('');
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20)}`;
}

function hexNibble(char: string): number | undefined {
  const code = char.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return undefined;
}

function invalidTenantId(tenantId: string): Error {
  return new Error(`tenant_id 不是合法的 UUID：${tenantId}`);
}

function compareCanonical(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * 在当前事务里按 tenant_id 升序写入多笔流水，并按这个顺序返回。
 *
 * 多租户写入必须在同一事务里只调用一次本函数，把全部租户放进这一次调用：
 * 写入之前一次拿齐这些租户的锁。非法 tenant_id 在发出任何 SQL 之前抛出错误。
 */
export async function appendLedgerEntries(
  tx: Tx,
  entries: readonly TenantLedgerWrite[],
): Promise<LedgerEntry[]> {
  const ordered = entries
    .map((write) => ({
      write,
      tenantId: canonicalTenantId(write.tenant.id),
    }))
    .sort((left, right) => compareCanonical(left.tenantId, right.tenantId));
  await lockTenants(
    tx,
    ordered.map(({ tenantId }) => tenantId),
  );
  const written: LedgerEntry[] = [];
  for (const { write, tenantId } of ordered) {
    written.push(await insertLedgerEntry(tx, tenantId, write.entry));
  }
  return written;
}
