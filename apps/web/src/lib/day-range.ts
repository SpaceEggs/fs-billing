import { formatDate } from './format';

/** 北京时间日期 YYYY-MM-DD，含两端，from 不晚于 to。 */
export type DayRange = { from: string; to: string };

/** 同长度的 YYYY-MM-DD 按字典序比较即按日期比较。 */
export function orderedRange(a: string, b: string): DayRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a };
}

/** 当前北京月份的 1 日到今天。 */
export function beijingMonthToDate(now: Date): DayRange {
  const today = formatDate(now);
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/**
 * 地址里的 from/to 缺一端或晚于今天时用本月默认值替换；颠倒的两端交换，不出现开始晚于结束的范围。
 */
export function rangeOrMonthToDate(
  search: { from?: string | undefined; to?: string | undefined },
  now: Date,
): DayRange {
  const fallback = beijingMonthToDate(now);
  const pastOr = (day: string | undefined, other: string) =>
    day !== undefined && day <= fallback.to ? day : other;
  return orderedRange(
    pastOr(search.from, fallback.from),
    pastOr(search.to, fallback.to),
  );
}

/** 电脑显示完整日期；手机同年时结束日省略年份，如「2026-09-01 — 09-29」。 */
export function rangeLabel(range: DayRange, short = false) {
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const end = short && sameYear ? range.to.slice(5) : range.to;
  return `${range.from} — ${end}`;
}

export type CalendarMonth = { year: number; month: number };

export function monthOf(date: string): CalendarMonth {
  return { year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) };
}

export function shiftMonth({ year, month }: CalendarMonth, delta: number) {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const pad = (value: number) => String(value).padStart(2, '0');

/** 周一开头的月历格子：月初前的空位为 null，其余为 YYYY-MM-DD。 */
export function monthCells({ year, month }: CalendarMonth): (string | null)[] {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const leading = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7;
  return [
    ...Array.from({ length: leading }, () => null),
    ...Array.from(
      { length: days },
      (_, index) => `${year}-${pad(month)}-${pad(index + 1)}`,
    ),
  ];
}
