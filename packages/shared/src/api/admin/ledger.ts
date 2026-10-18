import { z } from 'zod';
import { currencySchema } from '../identity.js';
import { moneyAmountSchema } from '../money.js';
import { pageNumberSchema } from '../cdr-fields.js';
import { checkDayRange, dayRangeFields } from '../day-range.js';
import { ledgerAmounts, mergedChargeRowSchema } from '../ledger-merge.js';
import { adminLedgerKindSchema } from './balance.js';
import { adminPageInfoSchema } from './common.js';
import { adminReceivableStatusSchema } from './receivables.js';

const adminManualFields = {
  id: z.uuid(),
  balanceAfter: moneyAmountSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  note: z.string(),
  actor: z.strictObject({ id: z.uuid(), name: z.string() }),
};

/** 人工流水：赊账充值的备注仅内部可见并带收款状态，其余没有收款状态。 */
const adminManualRow = <const Kind extends 'recharge' | 'gift' | 'adjustment'>(
  kind: Kind,
  amount: typeof ledgerAmounts.positive,
) =>
  z.strictObject({
    ...adminManualFields,
    kind: z.literal(kind),
    amount,
    noteVisibility: z.literal('customer'),
    paymentStatus: z.null(),
  });

/**
 * 后台流水行：与门户使用同一个合并查询，合并行（call_charge）完全相同，
 * 人工流水多收款状态、操作人和备注可见性。
 */
export const adminLedgerRowSchema = z.discriminatedUnion('kind', [
  adminManualRow('recharge', ledgerAmounts.positive),
  z.strictObject({
    ...adminManualFields,
    kind: z.literal('credit_recharge'),
    amount: ledgerAmounts.positive,
    noteVisibility: z.literal('admin'),
    paymentStatus: adminReceivableStatusSchema,
  }),
  adminManualRow('gift', ledgerAmounts.positive),
  adminManualRow('adjustment', ledgerAmounts.nonzero),
  mergedChargeRowSchema,
]);
export type AdminLedgerRow = z.infer<typeof adminLedgerRowSchema>;

export const adminLedgerQuerySchema = z
  .strictObject({
    ...dayRangeFields,
    kind: adminLedgerKindSchema.optional(),
    page: pageNumberSchema,
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .superRefine(checkDayRange);
export type AdminLedgerQuery = z.infer<typeof adminLedgerQuerySchema>;

export const adminLedgerResponseSchema = z.strictObject({
  currency: currencySchema,
  balance: moneyAmountSchema,
  totalAmount: moneyAmountSchema,
  items: z.array(adminLedgerRowSchema).max(100),
  pagination: adminPageInfoSchema,
});
export type AdminLedgerResponse = z.infer<typeof adminLedgerResponseSchema>;
