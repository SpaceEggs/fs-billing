import { z } from 'zod';
import { currencySchema } from '../identity.js';
import { moneyAmountSchema } from '../money.js';
import {
  adminMutationResponseSchema,
  adminInputAmountSchemas,
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminTimestampSchema,
} from './common.js';

const balanceFields = {
  currency: currencySchema,
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((key) => !key.startsWith('call:'), {
      message: 'call: 是通话扣费保留命名空间',
    }),
};
export const adminBalanceOperationRequestSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...balanceFields,
    kind: z.literal('topup'),
    amount: adminInputAmountSchemas.positive,
    note: z.string().max(2000).default(''),
  }),
  z.strictObject({
    ...balanceFields,
    kind: z.literal('credit_topup'),
    amount: adminInputAmountSchemas.positive,
    internalNote: z.string().max(2000).default(''),
  }),
  z.strictObject({
    ...balanceFields,
    kind: z.literal('gift'),
    amount: adminInputAmountSchemas.positive,
    note: z.string().max(2000).default(''),
  }),
  z.strictObject({
    ...balanceFields,
    kind: z.literal('adjustment'),
    amount: adminInputAmountSchemas.adjustment,
    reason: z.string().trim().min(1).max(2000),
  }),
]);
export const adminLedgerKindSchema = z.enum([
  'recharge',
  'credit_recharge',
  'gift',
  'adjustment',
  'call_charge',
]);
export const adminLedgerEntrySchema = z
  .strictObject({
    id: z.uuid(),
    kind: adminLedgerKindSchema,
    amount: moneyAmountSchema,
    balanceAfter: moneyAmountSchema,
    note: z.string(),
    noteVisibility: z.enum(['customer', 'admin']),
    paymentStatus: z.enum(['pending', 'received']).nullable(),
    actor: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    occurredAt: adminTimestampSchema,
  })
  .refine(
    (entry) =>
      entry.noteVisibility ===
      (entry.kind === 'credit_recharge' ? 'admin' : 'customer'),
    { message: '赊账备注仅管理员可见' },
  );
export const adminLedgerQuerySchema = adminPageQuerySchema
  .extend({
    kind: adminLedgerKindSchema.optional(),
    from: adminTimestampSchema.optional(),
    to: adminTimestampSchema.optional(),
  })
  .refine(
    (query) =>
      !query.from ||
      !query.to ||
      Date.parse(query.from) <= Date.parse(query.to),
    { message: '开始时间不能晚于结束时间' },
  );
export const adminLedgerResponseSchema = z.strictObject({
  currency: currencySchema,
  items: z.array(adminLedgerEntrySchema),
  pagination: adminPageInfoSchema,
});
export const adminBalanceOperationResponseSchema =
  adminMutationResponseSchema.extend({
    currency: currencySchema,
    entry: adminLedgerEntrySchema,
    balance: moneyAmountSchema,
  });

export type AdminBalanceOperationRequest = z.infer<
  typeof adminBalanceOperationRequestSchema
>;
export type AdminLedgerKind = z.infer<typeof adminLedgerKindSchema>;
export type AdminLedgerEntry = z.infer<typeof adminLedgerEntrySchema>;
export type AdminLedgerQuery = z.infer<typeof adminLedgerQuerySchema>;
export type AdminLedgerResponse = z.infer<typeof adminLedgerResponseSchema>;
export type AdminBalanceOperationResponse = z.infer<
  typeof adminBalanceOperationResponseSchema
>;
