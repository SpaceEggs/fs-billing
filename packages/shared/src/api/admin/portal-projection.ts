import { z } from 'zod';
import { moneyAmountSchema } from '../money.js';
import type { AdminLedgerEntry } from './balance.js';

export const portalLedgerEntrySchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(['recharge', 'gift', 'adjustment', 'call_charge']),
  amount: moneyAmountSchema,
  balanceAfter: moneyAmountSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  note: z.string(),
});
export type PortalLedgerEntry = z.infer<typeof portalLedgerEntrySchema>;

export function projectPortalLedgerEntry(
  entry: AdminLedgerEntry,
): PortalLedgerEntry {
  return {
    id: entry.id,
    kind: entry.kind === 'credit_recharge' ? 'recharge' : entry.kind,
    amount: entry.amount,
    balanceAfter: entry.balanceAfter,
    occurredAt: entry.occurredAt,
    note: entry.kind === 'credit_recharge' ? '' : entry.note,
  };
}
