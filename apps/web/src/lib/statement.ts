import Decimal from 'decimal.js';
import { latestRangeEnd, type StatementState } from '@fs-billing/shared';

/** 页面与组件共用的账单数字（门户与后台的响应都满足这个形状）。 */
export type StatementFigures = {
  openingBalance: string;
  recharge: string;
  gift: string;
  adjustment: string;
  callCharges: string;
  closingBalance: string;
  calls: number;
  callMinutes: string;
};
export type StatementCountry = {
  country: string;
  calls: number;
  minutes: string;
  charge: string;
};
export type StatementDay = {
  day: string;
  calls: number;
  minutes: string;
  charge: string;
};
export type { StatementState };

/** 2026-09 → 2026年9月。 */
export function statementMonthTitle(month: string) {
  return `${Number(month.slice(0, 4))}年${Number(month.slice(5, 7))}月`;
}

export function statementHref(month: string) {
  return `/portal/statements/${month}`;
}

/** 该月 1 日到最后一天，话单明细导出用（一个月的上限正好容得下一个自然月）。 */
export function statementMonthRange(month: string) {
  const from = `${month}-01`;
  return { from, to: latestRangeEnd(from) };
}

/** 下个月 1 日，进行中月份的「凌晨生成正式账单」提示用。 */
export function nextMonthFirstDay(month: string) {
  const year = Number(month.slice(0, 4));
  const next = Number(month.slice(5, 7)) + 1;
  const [nextYear, nextMonth] = next > 12 ? [year + 1, 1] : [year, next];
  return `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`;
}

const countFormat = new Intl.NumberFormat('en-US');

/** 计费分钟是整数；四舍五入后加千分位，不带单位（列表的「通话分钟数」列）。 */
export function minutesCount(value: string) {
  return countFormat.format(
    new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  );
}

const isZero = (value: string) => new Decimal(value).isZero();

/** 一个月没有任何活动：没有通话，期初、充值、赠送、调账、通话扣费全为 0。 */
export function hasNoActivity(figures: StatementFigures) {
  return (
    figures.calls === 0 &&
    [
      figures.openingBalance,
      figures.recharge,
      figures.gift,
      figures.adjustment,
      figures.callCharges,
    ].every(isZero)
  );
}

/**
 * 「还没有账单」空状态（决定 22）：没有任何已生成的账单，且实时的月份（进行中、待生成）都没有活动。
 * 接口总是返回进行中月份那一行，所以空状态要由页面判断。
 */
export function isStatementsEmpty(
  items: readonly { state: StatementState; figures: StatementFigures }[],
) {
  return items.every(
    (item) => item.state !== 'final' && hasNoActivity(item.figures),
  );
}

/** 某国家占通话扣费的百分比，一位小数；总额为 0 时没有占比。 */
export function chargeShare(charge: string, total: string) {
  const whole = new Decimal(total);
  if (whole.isZero()) return '—';
  return `${new Decimal(charge)
    .div(whole)
    .times(100)
    .toDecimalPlaces(1, Decimal.ROUND_HALF_UP)
    .toFixed(1)}%`;
}

function nextDay(day: string) {
  const [year = 0, month = 0, date = 0] = day.split('-').map(Number);
  const moved = new Date(Date.UTC(year, month - 1, date + 1));
  return `${String(moved.getUTCFullYear()).padStart(4, '0')}-${String(moved.getUTCMonth() + 1).padStart(2, '0')}-${String(moved.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 按日汇总覆盖区间内每一天（决定 23）：接口只返回有通话的日子，没有通话的补零。
 * 区间由接口给出：首月从开户日起，进行中月份到读取时的北京日。
 */
export function fillDays(
  period: { from: string; to: string },
  days: readonly StatementDay[],
): StatementDay[] {
  const byDay = new Map(days.map((row) => [row.day, row]));
  const filled: StatementDay[] = [];
  for (let day = period.from; day <= period.to; day = nextDay(day))
    filled.push(byDay.get(day) ?? { day, calls: 0, minutes: '0', charge: '0' });
  return filled;
}

/** 区间文字：2026-08-12（开户）至 2026-08-31；进行中月份结尾加（进行中）。 */
export function statementPeriodLabel(
  period: { from: string; to: string; openedOn: string | null },
  state: StatementState,
) {
  return `${period.from}${period.openedOn ? '（开户）' : ' '}至 ${period.to}${state === 'in_progress' ? '（进行中）' : ''}`;
}
