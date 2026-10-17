import { z } from 'zod';
import { moneyAmountSchema } from './money.js';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const timestamp = z.iso.datetime({ offset: true });

/** 北京日期，用于核对合并行的 day 与 occurredAt 属于同一天。 */
export function beijingDayOf(instant: string): string {
  return new Date(Date.parse(instant) + BEIJING_OFFSET_MS)
    .toISOString()
    .slice(0, 10);
}

/** 流水金额的符号规则与 ledger_entries_kind_shape 一致。 */
export const ledgerAmounts = {
  positive: moneyAmountSchema.refine(
    (value) => !value.startsWith('-') && /[1-9]/.test(value),
    { message: '金额必须大于零' },
  ),
  nonzero: moneyAmountSchema.refine((value) => /[1-9]/.test(value), {
    message: '金额不能为零',
  }),
  negative: moneyAmountSchema.refine((value) => value.startsWith('-'), {
    message: '通话扣费金额必须为负',
  }),
};

/**
 * 通话扣费按北京日合并后的一行。occurredAt 是当天最后一笔扣费的接通时间，
 * balanceAfter 是按显示顺序累计到这一行为止的余额。partial 为真表示 day 是读取时的当天，
 * 当天后续的扣费还会改变这一行。
 */
export const mergedChargeRowSchema = z
  .strictObject({
    kind: z.literal('call_charge'),
    day: z.iso.date(),
    calls: z.int().positive(),
    amount: ledgerAmounts.negative,
    balanceAfter: moneyAmountSchema,
    occurredAt: timestamp,
    partial: z.boolean(),
  })
  .superRefine((row, context) => {
    if (beijingDayOf(row.occurredAt) !== row.day)
      context.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: '合并行的时间必须落在 day 当天（北京时间）',
      });
  });
export type MergedChargeRow = z.infer<typeof mergedChargeRowSchema>;

const groupThousands = (value: number) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 合并行的备注，页面与 CSV 共用：「2026-09-28 通话扣费，共 356 通」。 */
export function formatMergedChargeNote(
  row: Pick<MergedChargeRow, 'day' | 'calls' | 'partial'>,
): string {
  const label = row.partial ? '通话扣费（截至当前）' : '通话扣费';
  return `${row.day} ${label}，共 ${groupThousands(row.calls)} 通`;
}
