import { z } from 'zod';

const DAY_MS = 86_400_000;

function parseDay(day: string) {
  const [year = 0, month = 0, date = 0] = day.split('-').map(Number);
  return { year, month, date };
}

function formatDay(utcMs: number) {
  return new Date(utcMs).toISOString().slice(0, 10);
}

/**
 * 范围最长一个月：结束日最晚为「开始日加一个日历月」的前一天。
 * 下个月没有同一天时取下个月最后一天，所以 01-31 的范围最晚到 02-27（平年）。
 */
export function latestRangeEnd(from: string): string {
  const { year, month, date } = parseDay(from);
  const lastOfNext = Date.UTC(year, month + 1, 0);
  const sameDayNext = Math.min(Date.UTC(year, month, date), lastOfNext);
  return formatDay(sameDayNext - DAY_MS);
}

export function isDayRangeWithinOneMonth(from: string, to: string): boolean {
  return from <= to && to <= latestRangeEnd(from);
}

/** 北京时间日期（YYYY-MM-DD），含两端。 */
export const dayRangeFields = {
  from: z.iso.date(),
  to: z.iso.date(),
};

export function checkDayRange(
  range: { from: string; to: string },
  context: z.RefinementCtx,
) {
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

/** 含两端的北京日范围转成半开区间 [start, end) 的 ISO 时刻，供服务端按 occurred_at / answered_at 过滤。 */
export function beijingRangeBounds(range: { from: string; to: string }) {
  const start = Date.parse(`${range.from}T00:00:00+08:00`);
  const end = Date.parse(`${range.to}T00:00:00+08:00`) + DAY_MS;
  return {
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  };
}
