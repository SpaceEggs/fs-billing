import Decimal from 'decimal.js';
import {
  beijingDateTimeParts,
  translate,
  type Currency,
  type Locale,
  type Money,
} from '@fs-billing/shared';
import { currentLocale } from '../i18n';

const currencySymbol = { CNY: '¥', USD: '$' } as const satisfies Record<
  Currency,
  string
>;

const monthKeys = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** 英文月份缩写从目录取（docs/i18n-design.md §7），中文目录里也有对应项。 */
export function monthName(month: number, locale: Locale) {
  const key = monthKeys[month - 1] ?? 'jan';
  return translate(locale, `format:months.${key}`);
}

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

/**
 * 费率固定 4 位小数；带单位时中文为“元/分钟”“$/分钟”，
 * 英文为“¥…/min”“$…/min”（docs/i18n-design.md §7）。
 */
export function formatRate(
  rate: string,
  options: { currency?: Currency; unit?: boolean; locale?: Locale } = {},
) {
  const value = new Decimal(rate).toFixed(4, Decimal.ROUND_HALF_UP);
  if (!options.unit || !options.currency) return value;
  const locale = options.locale ?? currentLocale();
  return translate(
    locale,
    options.currency === 'CNY' ? 'format:rate.cny' : 'format:rate.usd',
    { value },
  );
}

const pad = (value: number) => String(value).padStart(2, '0');

const year4 = (year: number) => String(year).padStart(4, '0');

type TimeParts = ReturnType<typeof beijingDateTimeParts>;

/** 业务日期仍是北京时间，语言只改写法：中文 YYYY-MM-DD，英文 DD MMM YYYY。 */
function formatDateParts(p: TimeParts, locale: Locale) {
  if (locale === 'en')
    return `${pad(p.day)} ${monthName(p.month, locale)} ${year4(p.year)}`;
  return `${year4(p.year)}-${pad(p.month)}-${pad(p.day)}`;
}

const formatTimeParts = (p: TimeParts) =>
  `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;

export function formatDateTime(
  value: string | Date,
  locale: Locale = currentLocale(),
) {
  const p = beijingDateTimeParts(value);
  return `${formatDateParts(p, locale)} ${formatTimeParts(p)}`;
}

export function formatDate(
  value: string | Date,
  locale: Locale = currentLocale(),
) {
  return formatDateParts(beijingDateTimeParts(value), locale);
}

export function formatTime(value: string | Date) {
  return formatTimeParts(beijingDateTimeParts(value));
}

export function formatMonth(
  value: string | Date,
  locale: Locale = currentLocale(),
) {
  const p = beijingDateTimeParts(value);
  return translate(locale, 'format:yearMonth', {
    year: p.year,
    month: locale === 'en' ? monthName(p.month, locale) : String(p.month),
  });
}

export function formatBilledMinutes(
  minutes: number,
  locale: Locale = currentLocale(),
) {
  return translate(locale, 'format:billedMinutes', { minutes });
}
