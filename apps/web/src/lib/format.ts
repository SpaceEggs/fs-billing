import Decimal from 'decimal.js';
import {
  beijingDateTimeParts,
  type Currency,
  type Money,
} from '@fs-billing/shared';

const currencySymbol = { CNY: '¥', USD: '$' } as const satisfies Record<
  Currency,
  string
>;

function groupThousands(integer: string) {
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function roundMoney(amount: string) {
  return new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function isNegativeMoney({ amount }: Money) {
  const rounded = roundMoney(amount);
  return rounded.isNegative() && !rounded.isZero();
}

/** 字符串十进制按 2 位四舍五入（ROUND_HALF_UP，与计费包一致），负号在币种符号前。 */
export function formatMoney(money: Money) {
  const [integer = '0', fraction = '00'] = roundMoney(money.amount)
    .abs()
    .toFixed(2)
    .split('.');
  const sign = isNegativeMoney(money) ? '-' : '';
  return `${sign}${currencySymbol[money.currency]}${groupThousands(integer)}.${fraction}`;
}

/** 不舍入的金额（如四位小数调账），至少 2 位小数，负号在币种符号前。 */
export function formatExactMoney(money: Money) {
  const value = new Decimal(money.amount);
  const [integer = '0', fraction = ''] = value.abs().toFixed().split('.');
  const sign = value.isNegative() && !value.isZero() ? '-' : '';
  return `${sign}${currencySymbol[money.currency]}${groupThousands(integer)}.${fraction.padEnd(2, '0')}`;
}

/** 费率固定 4 位小数；带单位时 CNY 为“元/分钟”，USD 为“$…/分钟”。 */
export function formatRate(
  rate: string,
  options: { currency?: Currency; unit?: boolean } = {},
) {
  const value = new Decimal(rate).toFixed(4, Decimal.ROUND_HALF_UP);
  if (!options.unit || !options.currency) return value;
  return options.currency === 'CNY' ? `${value} 元/分钟` : `$${value}/分钟`;
}

const pad = (value: number) => String(value).padStart(2, '0');

export function formatDateTime(value: string | Date) {
  const p = beijingDateTimeParts(value);
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function formatDate(value: string | Date) {
  const p = beijingDateTimeParts(value);
  return `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatTime(value: string | Date) {
  const p = beijingDateTimeParts(value);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export function formatMonth(value: string | Date) {
  const p = beijingDateTimeParts(value);
  return `${p.year}年${p.month}月`;
}

export function formatBilledMinutes(minutes: number) {
  return `${minutes}分钟`;
}
