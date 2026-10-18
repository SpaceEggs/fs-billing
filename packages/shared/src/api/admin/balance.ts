import { z } from 'zod';
import { currencySchema } from '../identity.js';
import { moneyAmountSchema } from '../money.js';
import { adminReceivableStatusSchema } from './receivables.js';
import {
  adminAuditedMutationResponseSchema,
  adminInputAmountSchemas,
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
export function createAdminBalanceOperationRequestSchema(
  amounts = adminInputAmountSchemas,
) {
  return z.discriminatedUnion('kind', [
    z.strictObject({
      ...balanceFields,
      kind: z.literal('topup'),
      amount: amounts.positive,
      note: z.string().max(2000).default(''),
    }),
    z.strictObject({
      ...balanceFields,
      kind: z.literal('credit_topup'),
      amount: amounts.positive,
      internalNote: z.string().max(2000).default(''),
    }),
    z.strictObject({
      ...balanceFields,
      kind: z.literal('gift'),
      amount: amounts.positive,
      note: z.string().max(2000).default(''),
    }),
    z.strictObject({
      ...balanceFields,
      kind: z.literal('adjustment'),
      amount: amounts.adjustment,
      reason: z.string().trim().min(1).max(2000),
    }),
  ]);
}
export const adminBalanceOperationRequestSchema =
  createAdminBalanceOperationRequestSchema();
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
    paymentStatus: adminReceivableStatusSchema.nullable(),
    actor: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
    occurredAt: adminTimestampSchema,
  })
  .refine(
    (entry) =>
      entry.noteVisibility ===
      (entry.kind === 'credit_recharge' ? 'admin' : 'customer'),
    { message: '赊账备注仅管理员可见' },
  );
export const adminBalanceOperationResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    currency: currencySchema,
    entry: adminLedgerEntrySchema,
    balance: moneyAmountSchema,
  });

export type AdminBalanceOperationRequest = z.infer<
  typeof adminBalanceOperationRequestSchema
>;
export type AdminLedgerKind = z.infer<typeof adminLedgerKindSchema>;
export type AdminLedgerEntry = z.infer<typeof adminLedgerEntrySchema>;
export type AdminBalanceOperationResponse = z.infer<
  typeof adminBalanceOperationResponseSchema
>;
