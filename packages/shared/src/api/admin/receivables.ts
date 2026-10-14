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
        receivedOn: z.iso.date(),
        confirmedBy: z.uuid(),
      }),
    ]),
  })
  .refine(
    (entry) =>
      entry.overdue ===
      (entry.payment.status === 'pending' && entry.ageDays > 30),
    { message: '待收款超过 30 天才标记逾期' },
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
  receivedOn: z.iso.date(),
  note: z.string().max(2000).default(''),
});
export const adminConfirmPaymentResponseSchema =
  adminMutationResponseSchema.extend({
    settlementId: z.uuid(),
    ledgerEntryId: z.uuid(),
    receivedOn: z.iso.date(),
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
