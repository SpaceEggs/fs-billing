import { z } from 'zod';
import { beijingDateOf } from './beijing-time.js';
import { moneyAmountSchema } from './money.js';
import { DEFAULT_LOCALE, type Locale } from '../i18n/index.js';
import { translate } from '../i18n/translate.js';

const timestamp = z.iso.datetime({ offset: true });

/** 北京日期，用于核对合并行的 day 与 occurredAt 属于同一天。 */
export const beijingDayOf = beijingDateOf;

/** 流水金额的符号规则与 ledger_entries_kind_shape 一致。 */
export const ledgerAmounts = {
  positive: moneyAmountSchema.refine(
    (value) => !value.startsWith('-') && /[1-9]/.test(value),
    { message: 'errors:validation.amount.positive' },
  ),
  nonzero: moneyAmountSchema.refine((value) => /[1-9]/.test(value), {
    message: 'errors:validation.amount.zero',
  }),
  negative: moneyAmountSchema.refine((value) => value.startsWith('-'), {
    message: 'errors:validation.amount.callChargeNegative',
  }),
};

/**
 * 通话扣费按北京日合并后的一行。occurredAt 是当天最后一笔扣费的接通时间，
 * balanceAfter 是按 (occurred_at, id) 升序累计到这一行为止的余额；合并行的位置取当天最后一笔扣费的 (occurred_at, id)，
 * 所以并列时与同一时刻的人工流水的先后和逐笔余额一致。partial 为真表示 day 是读取时的当天，
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
    // 格式错误已经由 occurredAt 字段报告；无效时刻无法换算成日期。
    if (!Number.isFinite(Date.parse(row.occurredAt))) return;
    if (beijingDayOf(row.occurredAt) !== row.day)
      context.addIssue({
        code: 'custom',
        path: ['occurredAt'],
        message: 'errors:validation.ledger.mergeDayMismatch',
      });
  });
export type MergedChargeRow = z.infer<typeof mergedChargeRowSchema>;

const groupThousands = (value: number) =>
  String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** 合并行的备注，页面与 CSV 共用：「2026-09-28 通话扣费，共 356 通」。 */
export function formatMergedChargeNote(
  row: Pick<MergedChargeRow, 'day' | 'calls' | 'partial'>,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const label = translate(
    locale,
    row.partial
      ? 'enums:ledger.mergedChargePartial'
      : 'enums:ledger.mergedCharge',
  );
  const callsKey =
    locale === 'en' && row.calls === 1
      ? 'enums:ledger.mergedChargeCalls_one'
      : 'enums:ledger.mergedChargeCalls_other';
  const calls = translate(locale, callsKey, {
    count: groupThousands(row.calls),
  });
  return `${row.day} ${label}${locale === 'zh' ? '，' : ', '}${calls}`;
}
