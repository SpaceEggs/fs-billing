import Decimal from 'decimal.js';
import {
  beijingDateTimeParts,
  formatMergedChargeNote,
  translate,
  type Currency,
  type Locale,
  type MergedChargeRow,
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

export function formatYearMonth(
  year: number,
  monthNumber: number,
  locale: Locale = currentLocale(),
) {
  return translate(locale, 'format:yearMonth', {
    year,
    month:
      locale === 'en' ? monthName(monthNumber, locale) : String(monthNumber),
  });
}

export function formatMonth(
  value: string | Date,
  locale: Locale = currentLocale(),
) {
  const p = beijingDateTimeParts(value);
  return formatYearMonth(p.year, p.month, locale);
}

export function formatYear(year: number, locale: Locale = currentLocale()) {
  return translate(locale, 'format:year', { year });
}

function dayParts(value: string) {
  return {
    year: value.slice(0, 4),
    month: Number(value.slice(5, 7)),
    day: value.slice(8, 10),
    monthText: value.slice(5, 7),
  };
}

/** 业务日期的短写：中文 MM-DD，英文 DD MMM（图表的日期标注、手机卡片）。 */
export function formatMonthDay(
  value: string,
  locale: Locale = currentLocale(),
) {
  const p = dayParts(value);
  return locale === 'en'
    ? `${p.day} ${monthName(p.month, locale)}`
    : `${p.monthText}-${p.day}`;
}

/** 业务日期的完整写法：中文 YYYY-MM-DD，英文 DD MMM YYYY。 */
export function formatDay(value: string, locale: Locale = currentLocale()) {
  const p = dayParts(value);
  return locale === 'en'
    ? `${p.day} ${monthName(p.month, locale)} ${p.year}`
    : `${p.year}-${p.monthText}-${p.day}`;
}

/**
 * 手机卡片的短时间：中文 MM-DD HH:mm:ss，英文 DD MMM HH:mm:ss。
 * `seconds: false` 去掉秒（门户流水卡片的 MM-DD HH:mm）。
 */
export function formatShortDateTime(
  value: string | Date,
  locale: Locale = currentLocale(),
  seconds = true,
) {
  const p = beijingDateTimeParts(value);
  const time = seconds ? formatTimeParts(p) : `${pad(p.hour)}:${pad(p.minute)}`;
  if (locale === 'en')
    return `${pad(p.day)} ${monthName(p.month, locale)} ${time}`;
  return `${pad(p.month)}-${pad(p.day)} ${time}`;
}

/** 日期区间：中文与 lib/day-range 的 rangeLabel 逐字一致，英文用月份名。 */
export function formatDayRange(
  range: { from: string; to: string },
  short = false,
  locale: Locale = currentLocale(),
) {
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const from = formatDay(range.from, locale);
  const to =
    short && sameYear
      ? formatMonthDay(range.to, locale)
      : formatDay(range.to, locale);
  return `${from} — ${to}`;
}

export function formatBilledMinutes(
  minutes: number,
  locale: Locale = currentLocale(),
) {
  return translate(locale, 'format:billedMinutes', { minutes });
}

/** 合并扣费备注：日期用页面统一的写法（中文 YYYY-MM-DD，英文 DD MMM YYYY），CSV 仍用原日期。 */
export function formatLedgerChargeNote(
  row: Pick<MergedChargeRow, 'day' | 'calls' | 'partial'>,
  locale: Locale = currentLocale(),
) {
  return formatMergedChargeNote(row, locale, formatDay(row.day, locale));
}
