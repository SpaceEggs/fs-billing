import { z } from 'zod';
import { currencySchema } from '../identity.js';
import { moneyAmountSchema } from '../money.js';
import { pageNumberSchema } from '../cdr-fields.js';
import { checkDayRange, dayRangeFields } from '../day-range.js';
import { ledgerAmounts, mergedChargeRowSchema } from '../ledger-merge.js';

export const PORTAL_LEDGER_PAGE_SIZE = 25;
/** 赊账充值对客户显示的备注；内部备注不离开数据库。 */
export const PORTAL_CREDIT_RECHARGE_NOTE = '账户充值';

/** 客户看到的类型。赊账充值与充值同属 recharge，所以没有 credit_recharge。 */
export const portalLedgerKindSchema = z.enum([
  'recharge',
  'gift',
  'adjustment',
  'call_charge',
]);
export type PortalLedgerKind = z.infer<typeof portalLedgerKindSchema>;

const manualFields = {
  id: z.uuid(),
  balanceAfter: moneyAmountSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  note: z.string(),
};

/**
 * 一行流水：人工流水逐笔，通话扣费按北京日合并。strict 且不含收款状态、操作人、
 * 内部备注，也没有 credit_recharge 这个类型。
 */
export const portalLedgerRowSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...manualFields,
    kind: z.literal('recharge'),
    amount: ledgerAmounts.positive,
  }),
  z.strictObject({
    ...manualFields,
    kind: z.literal('gift'),
    amount: ledgerAmounts.positive,
  }),
  z.strictObject({
    ...manualFields,
    kind: z.literal('adjustment'),
    amount: ledgerAmounts.nonzero,
  }),
  mergedChargeRowSchema,
]);
export type PortalLedgerRow = z.infer<typeof portalLedgerRowSchema>;

export const portalLedgerQuerySchema = z
  .strictObject({
    ...dayRangeFields,
    kind: portalLedgerKindSchema.optional(),
    page: pageNumberSchema,
  })
  .superRefine(checkDayRange);
export type PortalLedgerQuery = z.infer<typeof portalLedgerQuerySchema>;

export const portalLedgerExportRequestSchema = z
  .strictObject({ ...dayRangeFields, kind: portalLedgerKindSchema.optional() })
  .superRefine(checkDayRange);
export type PortalLedgerExportRequest = z.infer<
  typeof portalLedgerExportRequestSchema
>;

export const portalLedgerResponseSchema = z.strictObject({
  currency: currencySchema,
  /** 读取时的当前余额，页头显示。 */
  balance: moneyAmountSchema,
  /** 筛选后全部行（不只当前页）的金额合计，类型筛选时显示。 */
  totalAmount: moneyAmountSchema,
  items: z.array(portalLedgerRowSchema).max(PORTAL_LEDGER_PAGE_SIZE),
  pagination: z.strictObject({
    page: z.int().min(1),
    /** 门户每页固定 25 条（决定 37），响应不接受别的值。 */
    pageSize: z.literal(PORTAL_LEDGER_PAGE_SIZE),
    total: z.int().nonnegative(),
  }),
});
export type PortalLedgerResponse = z.infer<typeof portalLedgerResponseSchema>;
