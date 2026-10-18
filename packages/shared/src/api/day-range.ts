import { z } from 'zod';

const MAX_YEAR = 9999;

function parseDay(day: string) {
  const [year = 0, month = 0, date = 0] = day.split('-').map(Number);
  return { year, month, date };
}

function formatDay(year: number, month: number, date: number) {
  const pad = (value: number, width: number) =>
    String(value).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(date, 2)}`;
}

const isLeapYear = (year: number) =>
  (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

function daysInMonth(year: number, month: number) {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * 范围最长一个月：结束日最晚为「开始日加一个日历月」的前一天。
 * 下个月没有同一天时取下个月最后一天，所以 01-31 的范围最晚到 02-27（平年）。
 * 用整数年月日计算而不是 Date.UTC，后者把 0000 至 0099 年当成 1900 至 1999 年；
 * 9999-12 的下一个月超出四位年份，最晚结束日取 9999-12-31。
 */
export function latestRangeEnd(from: string): string {
  const { year, month, date } = parseDay(from);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const sameDayNext = Math.min(date, daysInMonth(nextYear, nextMonth));
  if (sameDayNext > 1) return clampYear(nextYear, nextMonth, sameDayNext - 1);
  return formatDay(year, month, daysInMonth(year, month));
}

function clampYear(year: number, month: number, date: number) {
  return year > MAX_YEAR
    ? formatDay(MAX_YEAR, 12, 31)
    : formatDay(year, month, date);
}

/** 北京时间日期（YYYY-MM-DD），含两端。 */
const supportedDaySchema = z.iso.date().refine((day) => day >= '0001-01-01', {
  message: '日期范围必须在 0001-01-01 至 9999-12-31 之间',
});

export const dayRangeFields = {
  from: supportedDaySchema,
  to: supportedDaySchema,
};

const isDay = (value: string) => dayRangeFields.from.safeParse(value).success;

export function isDayRangeWithinOneMonth(from: string, to: string): boolean {
  return isDay(from) && isDay(to) && from <= to && to <= latestRangeEnd(from);
}

/** 两端都是合法日期才检查范围；格式错误已经由字段本身报告，这里再算日期会抛出 RangeError。 */
export function checkDayRange(
  range: { from: string; to: string },
  context: z.RefinementCtx,
) {
  if (!isDay(range.from) || !isDay(range.to)) return;
  if (range.from > range.to)
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: '结束日期不能早于开始日期',
    });
  else if (range.to > latestRangeEnd(range.from))
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: '日期范围最长一个月',
    });
}
