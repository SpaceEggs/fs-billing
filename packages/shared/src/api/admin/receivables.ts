import { z } from 'zod';
import { currencySchema, tenantIdentitySchema } from '../identity.js';
import {
  adminMutationResponseSchema,
  adminNonnegativeAmountSchema,
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminPositiveAmountSchema,
  adminTimestampSchema,
} from './common.js';

function beijingDate(timestamp: number): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
export const adminReceivableStatusSchema = z.enum([
  'pending',
  'received',
  'voided',
]);
const receivedOnSchema = z.iso
  .date()
  .refine((date) => date <= beijingDate(Date.now()), {
    message: '收款日期不能晚于当前北京时间日期',
  });

export const adminCurrencyTotalsSchema = z.strictObject({
  CNY: adminNonnegativeAmountSchema,
  USD: adminNonnegativeAmountSchema,
});
export const adminReceivableSchema = z
  .strictObject({
    ledgerEntryId: z.uuid(),
    latestSettlementId: z.uuid().nullable(),
    tenant: tenantIdentitySchema,
    amount: adminPositiveAmountSchema,
    internalNote: z.string(),
    createdAt: adminTimestampSchema,
    actor: z.strictObject({ id: z.uuid(), name: z.string() }),
    ageDays: z.number().int().nonnegative(),
    overdue: z.boolean(),
    payment: z.discriminatedUnion('status', [
      z.strictObject({ status: z.literal('pending') }),
      z.strictObject({
        status: z.literal('received'),
        settlementId: z.uuid(),
        receivedOn: receivedOnSchema,
        note: z.string().max(2000),
        confirmedBy: z.uuid(),
      }),
      z.strictObject({
        status: z.literal('voided'),
        voidId: z.uuid(),
        adjustmentLedgerEntryId: z.uuid(),
        reason: z.string().trim().min(1).max(2000),
        voidedBy: z.uuid(),
        voidedAt: adminTimestampSchema,
      }),
    ]),
  })
  .refine(
    (entry) =>
      entry.payment.status !== 'received' ||
      entry.latestSettlementId === entry.payment.settlementId,
    { message: '已收款必须引用最新确认事件', path: ['latestSettlementId'] },
  )
  .refine(
    (entry) =>
      entry.overdue ===
      (entry.payment.status === 'pending' && entry.ageDays > 30),
    { message: '待收款超过 30 天才标记逾期' },
  )
  .refine(
    (entry) =>
      entry.payment.status !== 'received' ||
      entry.payment.receivedOn >= beijingDate(Date.parse(entry.createdAt)),
    { message: '收款日期不能早于赊账日期', path: ['payment', 'receivedOn'] },
  );
export const adminReceivablesQuerySchema = adminPageQuerySchema.extend({
  search: z.string().max(200).optional(),
  currency: currencySchema.optional(),
  status: adminReceivableStatusSchema.default('pending'),
});
export const adminReceivablesResponseSchema = z.strictObject({
  items: z.array(adminReceivableSchema),
  totals: adminCurrencyTotalsSchema,
  pagination: adminPageInfoSchema,
});
export const adminConfirmPaymentRequestSchema = z.strictObject({
  expectedLatestSettlementId: z.uuid().nullable(),
  receivedOn: receivedOnSchema,
  note: z.string().max(2000).default(''),
});
export const adminConfirmPaymentResponseSchema =
  adminMutationResponseSchema.extend({
    settlementId: z.uuid(),
    ledgerEntryId: z.uuid(),
    receivedOn: receivedOnSchema,
  });

export type AdminCurrencyTotals = z.infer<typeof adminCurrencyTotalsSchema>;
export type AdminReceivable = z.infer<typeof adminReceivableSchema>;
export type AdminReceivablesQuery = z.infer<typeof adminReceivablesQuerySchema>;
export type AdminReceivablesResponse = z.infer<
  typeof adminReceivablesResponseSchema
>;
export type AdminConfirmPaymentRequest = z.infer<
  typeof adminConfirmPaymentRequestSchema
>;
export type AdminConfirmPaymentResponse = z.infer<
  typeof adminConfirmPaymentResponseSchema
>;

export const adminVoidReceivableRequestSchema = z.strictObject({
  adjustmentLedgerEntryId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
});
export const adminVoidReceivableResponseSchema =
  adminMutationResponseSchema.extend({
    ledgerEntryId: z.uuid(),
    voidId: z.uuid(),
  });
export const adminReversePaymentRequestSchema = z.strictObject({
  settlementId: z.uuid(),
  reason: z.string().trim().min(1).max(2000),
});
export const adminReversePaymentResponseSchema =
  adminMutationResponseSchema.extend({
    ledgerEntryId: z.uuid(),
    settlementId: z.uuid(),
    reversalId: z.uuid(),
  });
export type AdminReceivableStatus = z.infer<typeof adminReceivableStatusSchema>;
export type AdminVoidReceivableRequest = z.infer<
  typeof adminVoidReceivableRequestSchema
>;
export type AdminVoidReceivableResponse = z.infer<
  typeof adminVoidReceivableResponseSchema
>;
export type AdminReversePaymentRequest = z.infer<
  typeof adminReversePaymentRequestSchema
>;
export type AdminReversePaymentResponse = z.infer<
  typeof adminReversePaymentResponseSchema
>;
