import Decimal from 'decimal.js';
import {
  adminRateAmountSchema,
  type AdminRateChange,
  type AdminRateEntry,
  type AdminRateSchedule,
} from '@fs-billing/shared';
import { ApiRequestError } from './api';
import { apiProblem } from './api-problem';
import { formatDateTime } from './format';

/** 与服务端预览相同的比较：前缀相同而国家或费率（按数值）不同算修改。 */
export function diffRateTables(
  before: readonly AdminRateEntry[],
  after: readonly AdminRateEntry[],
): AdminRateChange[] {
  const previous = new Map(before.map((entry) => [entry.prefix, entry]));
  const changes: AdminRateChange[] = [];
  for (const entry of after) {
    const old = previous.get(entry.prefix);
    if (!old) changes.push({ kind: 'added', after: entry });
    else if (
      old.country !== entry.country ||
      !new Decimal(old.rate).eq(entry.rate)
    )
      changes.push({ kind: 'modified', before: old, after: entry });
    previous.delete(entry.prefix);
  }
  for (const entry of previous.values())
    changes.push({ kind: 'deleted', before: entry });
  return changes;
}

export function countChanges(changes: readonly AdminRateChange[]) {
  const counts = { added: 0, modified: 0, deleted: 0 };
  for (const change of changes) counts[change.kind] += 1;
  return counts;
}

/** 涨跌幅，1 位小数；旧费率为 0 或费率未变时没有涨跌幅。 */
export function rateChangePercent(before: string, after: string) {
  const old = new Decimal(before);
  const next = new Decimal(after);
  if (old.isZero() || old.eq(next)) return null;
  const percent = next.minus(old).div(old).times(100);
  return {
    rising: percent.isPositive(),
    text: `${percent.isPositive() ? '+' : ''}${percent.toFixed(1, Decimal.ROUND_HALF_UP)}%`,
  };
}

const beijingOffsetMs = 8 * 60 * 60 * 1000;
const minuteMs = 60 * 1000;
const minutePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/**
 * 北京时间分钟（`datetime-local` 的 `YYYY-MM-DDTHH:mm`）转 ISO，秒固定为 00、带 +08:00。
 * 不存在的日期（如 02-30）返回 null。
 */
export function beijingMinuteToIso(minute: string) {
  const match = minutePattern.exec(minute);
  if (!match) return null;
  const [year, month, day, hour, min] = match.slice(1).map(Number);
  const utc = Date.UTC(year!, month! - 1, day, hour! - 8, min);
  if (beijingMinute(utc) !== minute) return null;
  return `${minute}:00+08:00`;
}

/** 某一时刻所在的北京时间分钟（向下取整），格式同 `datetime-local`。 */
export function beijingMinute(instant: number) {
  return new Date(Math.floor((instant + beijingOffsetMs) / minuteMs) * minuteMs)
    .toISOString()
    .slice(0, 16);
}

/** 可选范围：不早于当前时刻所在分钟的下一分钟，不晚于 now + horizon 所在分钟。 */
export function scheduleBounds(now: number, horizonMs: number) {
  return {
    min: beijingMinute(Math.ceil(now / minuteMs) * minuteMs),
    max: beijingMinute(now + horizonMs),
  };
}

export type ScheduleChoice =
  { kind: 'immediate' } | { kind: 'scheduled'; minute: string };

/** 与契约相同的闭区间 [now, now + horizon]；`now` 取提交时刻。 */
export function resolveSchedule(
  choice: ScheduleChoice,
  now: number,
  horizonMs: number,
): { schedule: AdminRateSchedule } | { error: string } {
  if (choice.kind === 'immediate') return { schedule: { kind: 'immediate' } };
  const effectiveFrom = beijingMinuteToIso(choice.minute);
  if (!effectiveFrom) return { error: '请选择生效时间' };
  const at = Date.parse(effectiveFrom);
  if (at < now) return { error: '生效时间必须晚于当前时间' };
  if (at > now + horizonMs)
    return {
      error: `生效时间不能晚于 ${formatDateTime(new Date(now + horizonMs))}`,
    };
  return { schedule: { kind: 'scheduled', effectiveFrom } };
}

export type RateEditDraft = { country: string; rate: string };
export type RateEditField = 'country' | 'rate' | 'effectiveFrom';
export type RateEditErrors = Partial<Record<RateEditField, string>>;

/** 第一步校验，通过时返回提交用的完整条目。 */
export function validateRateEdit(
  current: AdminRateEntry,
  draft: RateEditDraft,
): { entry: AdminRateEntry } | { errors: RateEditErrors } {
  const errors: RateEditErrors = {};
  const country = draft.country.trim();
  if (!country) errors.country = '请输入国家/备注';
  else if (country.length > 200) errors.country = '国家/备注不能超过 200 字';
  else if (/[\r\n]/.test(country)) errors.country = '国家/备注不能包含换行';
  const rate = draft.rate.trim();
  if (!rate) errors.rate = '请输入费率';
  else if (rate.startsWith('-')) errors.rate = '费率不能为负数';
  else if (/^\d+\.\d{5,}$/.test(rate)) errors.rate = '小数不超过 4 位';
  else if (!adminRateAmountSchema.safeParse(rate).success)
    errors.rate = '请输入有效的费率';
  if (errors.country || errors.rate) return { errors };
  if (country === current.country && new Decimal(rate).eq(current.rate))
    return { errors: { rate: '新费率与当前费率相同' } };
  return { entry: { prefix: current.prefix, country, rate } };
}

const issueFields: Record<string, RateEditField> = {
  'entry.country': 'country',
  'entry.rate': 'rate',
  'schedule.effectiveFrom': 'effectiveFrom',
};

/**
 * 提交失败的去向：条目字段的校验错误退回第一步并标在字段上，生效时间错误留在确认步；
 * 其他失败（无对应字段的校验、冲突、限流、不可用）由确认步的通用提示说明。
 */
export function rateEditFailure(error: unknown): {
  step: 'form' | 'confirm';
  fields: RateEditErrors;
  general: boolean;
} {
  const problem = apiProblem(error);
  if (problem.kind !== 'validation')
    return { step: 'confirm', fields: {}, general: true };
  const fields: RateEditErrors = {};
  let general = false;
  for (const issue of problem.issues) {
    const field = issueFields[issue.path.join('.')];
    if (!field) general = true;
    else fields[field] ??= issue.message;
  }
  return {
    step: fields.country || fields.rate ? 'form' : 'confirm',
    fields,
    general,
  };
}

/**
 * 取消排定被拒：版本已生效、距生效不足取消余量（服务端按数据库时间判断），
 * 或已被他人取消、替换。都需要刷新后再看。
 */
export function cancelFailureMessage(error: unknown) {
  if (error instanceof ApiRequestError && error.status === 0) return null;
  const problem = apiProblem(error);
  if (problem.kind === 'conflict' && problem.code === 'RATE_VERSION_CONFLICT')
    return '该版本已生效或即将生效，不能取消；也可能费率表已被修改。请刷新后查看。';
  if (problem.kind === 'not-found')
    return '该排定版本已不存在，可能已被取消。请刷新后查看。';
  return null;
}
