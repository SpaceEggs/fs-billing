import { z } from 'zod';
import {
  CDR_MAX_PAGE,
  calleeSearchSchema,
  cdrStatusSchema,
  dayRangeFields,
} from '@fs-billing/shared';
import type { DayRange } from './day-range';

/**
 * 话单筛选的地址状态，门户页和后台租户详情的话单标签页共用：
 * 默认值（已接通、第 1 页、本月）不写入地址，刷新与登录过期后回到同一视图。
 * 每个键都显式返回，非法时为 undefined，一个错参数不清空其余筛选。
 */
export type CdrFilters = {
  callee?: string | undefined;
  country?: string | undefined;
  /** 缺省为只看已接通。 */
  status?: 'all' | undefined;
  /** 只有后台话单有该筛选。 */
  unverifiedOnly?: true | undefined;
};

const countrySchema = z.string().trim().min(1).max(200);

/** 路由把纯数字的查询值解析成 number，被叫号码要按文本使用。 */
function textOf(raw: unknown) {
  const text = typeof raw === 'number' ? String(raw) : raw;
  const parsed = z.string().trim().min(1).max(200).safeParse(text);
  return parsed.success ? parsed.data : undefined;
}

export function validateCdrFilters(raw: Record<string, unknown>): CdrFilters {
  return {
    callee: textOf(raw['callee']),
    country: countrySchema.safeParse(raw['country']).data,
    status: raw['status'] === 'all' ? 'all' : undefined,
    unverifiedOnly: raw['unverifiedOnly'] === true ? true : undefined,
  };
}

export function validateCdrRange(raw: Record<string, unknown>) {
  return {
    from: dayRangeFields.from.safeParse(raw['from']).data,
    to: dayRangeFields.to.safeParse(raw['to']).data,
  };
}

/** 页码从 2 起才写入地址。 */
export function validateCdrPage(raw: unknown) {
  const page = z.int().min(1).max(CDR_MAX_PAGE).safeParse(raw).data;
  return page !== undefined && page > 1 ? page : undefined;
}

export type PortalCdrsSearch = CdrFilters & {
  from?: string | undefined;
  to?: string | undefined;
  page?: number | undefined;
};

export function validatePortalCdrsSearch(
  raw: Record<string, unknown>,
): PortalCdrsSearch {
  const filters = validateCdrFilters(raw);
  return {
    callee: filters.callee,
    country: filters.country,
    status: filters.status,
    ...validateCdrRange(raw),
    page: validateCdrPage(raw['page']),
  };
}

/** 被叫号码搜索词不合规时的说明；合规返回 null，此时不应发请求。 */
export function calleeProblem(callee: string | undefined) {
  if (callee === undefined) return null;
  const parsed = calleeSearchSchema.safeParse(callee);
  return parsed.success
    ? null
    : (parsed.error.issues[0]?.message ?? '被叫号码格式不正确');
}

/** 列表、国家选项与导出共用的筛选查询；页码由调用方另加。 */
export function cdrListQuery(range: DayRange, filters: CdrFilters) {
  return {
    ...range,
    ...(filters.callee ? { callee: filters.callee } : {}),
    ...(filters.country ? { country: filters.country } : {}),
    status: cdrStatusSchema.parse(filters.status ?? 'answered'),
  };
}
