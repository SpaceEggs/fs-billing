import Decimal from 'decimal.js';
import type { Currency, Money } from '@fs-billing/shared';

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

/** 费率固定 4 位小数；带单位时 CNY 为“元/分钟”，USD 为“$…/分钟”。 */
export function formatRate(
  rate: string,
  options: { currency?: Currency; unit?: boolean } = {},
) {
  const value = new Decimal(rate).toFixed(4, Decimal.ROUND_HALF_UP);
  if (!options.unit || !options.currency) return value;
  return options.currency === 'CNY' ? `${value} 元/分钟` : `$${value}/分钟`;
}

const beijingOffsetMs = 8 * 60 * 60 * 1000;
const pad = (value: number) => String(value).padStart(2, '0');

/** 中国不实行夏令时，北京时间固定为 UTC+8。 */
function beijingParts(value: string | Date) {
  const instant = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(instant.getTime()))
    throw new RangeError(`Invalid date: ${String(value)}`);
  const shifted = new Date(instant.getTime() + beijingOffsetMs);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

export function formatDateTime(value: string | Date) {
  const p = beijingParts(value);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

export function formatDate(value: string | Date) {
  const p = beijingParts(value);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function formatMonth(value: string | Date) {
  const p = beijingParts(value);
  return `${p.year}年${p.month}月`;
}

/** 通话时长与倒计时：3分50秒、12分04秒。 */
export function formatDuration(durationSeconds: number) {
  const seconds = Math.max(0, Math.ceil(durationSeconds));
  return `${Math.floor(seconds / 60)}分${pad(seconds % 60)}秒`;
}

export function formatBilledMinutes(minutes: number) {
  return `${minutes}分钟`;
}
