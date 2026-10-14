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
        receivedOn: receivedOnSchema,
        note: z.string().max(2000),
        confirmedBy: z.uuid(),
      }),
    ]),
  })
  .refine(
    (entry) =>
      entry.overdue ===
      (entry.payment.status === 'pending' && entry.ageDays > 30),
    { message: '待收款超过 30 天才标记逾期' },
  )
  .refine(
    (entry) =>
      entry.payment.status === 'pending' ||
      entry.payment.receivedOn >= beijingDate(Date.parse(entry.createdAt)),
    { message: '收款日期不能早于赊账日期', path: ['payment', 'receivedOn'] },
  );
export const adminReceivablesQuerySchema = adminPageQuerySchema.extend({
  search: z.string().max(200).optional(),
  currency: currencySchema.optional(),
  status: z.enum(['pending', 'received']).default('pending'),
});
export const adminReceivablesResponseSchema = z.strictObject({
  items: z.array(adminReceivableSchema),
  totals: adminCurrencyTotalsSchema,
  pagination: adminPageInfoSchema,
});
export const adminConfirmPaymentRequestSchema = z.strictObject({
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
