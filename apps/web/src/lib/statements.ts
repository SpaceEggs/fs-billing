import Decimal from 'decimal.js';
import { addDecimalStrings, latestRangeEnd } from '@fs-billing/shared';
import { formatDate } from './format';

/** 账单月份 YYYY-MM 显示为「2026年9月」。 */
export function statementMonthLabel(month: string) {
  return `${month.slice(0, 4)}年${Number(month.slice(5, 7))}月`;
}

/** 当前北京月的上一个月（后台账单页的默认月份，也是能选的最晚月份）。 */
export function previousBeijingMonth(now: Date) {
  return shiftStatementMonth(formatDate(now).slice(0, 7), -1);
}

export function shiftStatementMonth(month: string, delta: number) {
  const index =
    Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export function statementMonthStart(month: string) {
  return `${month}-01`;
}

export function statementMonthEnd(month: string) {
  return latestRangeEnd(statementMonthStart(month));
}

export type StatementCountryRow = {
  country: string;
  calls: number;
  minutes: string;
  charge: string;
};
export type StatementDayRow = {
  day: string;
  calls: number;
  minutes: string;
  charge: string;
};

/** 国家或日期明细各列的合计：每一列等于表里各行之和，表尾「合计」与上面的行对得上。 */
export function sumStatementRows(
  rows: readonly { calls: number; minutes: string; charge: string }[],
) {
  return {
    calls: rows.reduce((count, row) => count + row.calls, 0),
    minutes: addDecimalStrings(rows.map((row) => row.minutes)),
    charge: addDecimalStrings(rows.map((row) => row.charge)),
  };
}

/** 占比：该国家费用占各国家费用合计的百分比，保留 1 位；合计为 0 时显示 0.0%。 */
export function countryShare(charge: string, total: string) {
  const whole = new Decimal(total);
  if (whole.isZero()) return '0.0%';
  return `${new Decimal(charge).div(whole).mul(100).toFixed(1, Decimal.ROUND_HALF_UP)}%`;
}

/** 日期 from 到 to（含两端）的每一天，YYYY-MM-DD。 */
export function daysBetween(from: string, to: string) {
  const days: string[] = [];
  const end = Date.UTC(
    Number(to.slice(0, 4)),
    Number(to.slice(5, 7)) - 1,
    Number(to.slice(8, 10)),
  );
  for (
    let moment = Date.UTC(
      Number(from.slice(0, 4)),
      Number(from.slice(5, 7)) - 1,
      Number(from.slice(8, 10)),
    );
    moment <= end;
    moment += 86_400_000
  )
    days.push(new Date(moment).toISOString().slice(0, 10));
  return days;
}

/** 区间内每天一行，没有通话的日子补零（决定 23）。接口只返回有通话的日子。 */
export function fillStatementDays(
  period: { from: string; to: string },
  days: readonly StatementDayRow[],
): StatementDayRow[] {
  const byDay = new Map(days.map((row) => [row.day, row]));
  return daysBetween(period.from, period.to).map(
    (day) => byDay.get(day) ?? { day, calls: 0, minutes: '0', charge: '0' },
  );
}

export type ReconcileStatus = 'unchecked' | 'ok' | 'stale' | 'inconsistent';

/**
 * 核对不一致时写在生成时间下面的备注（决定 27）：stale 即「账单已过期」，
 * inconsistent 即「账单与流水不一致」；一致、未核对与没有账单行都没有备注。
 */
export function reconcileNote(status: ReconcileStatus | null) {
  if (status === 'stale') return '账单已过期';
  if (status === 'inconsistent') return '账单与流水不一致';
  return null;
}

/** 重新生成不可用的原因；可用时为 null。 */
export const regenerateReasons = {
  in_progress: '进行中，月结后可重新生成',
  details_deleted: '话单已删除，无法重新计算',
} as const;

/** 计费分钟：千分位，整数不带小数（「37,468」）。 */
export function formatStatementMinutes(value: string) {
  const [integer = '0', fraction] = new Decimal(value).toFixed().split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction ? `${grouped}.${fraction}` : grouped;
}

export function formatStatementCalls(value: number) {
  return value.toLocaleString('en-US');
}
