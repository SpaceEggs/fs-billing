import Decimal from 'decimal.js';
import type { AdminTenantOverviewResponse, Currency } from '@fs-billing/shared';
import { webConfig } from '../config';
import { apiKey } from './admin-api';
import { callApi } from './api';

/**
 * 概况标签页（设计稿第三批 1a/3a）需要的数据。统计接口尚在开发：
 * 现有契约没有的字段为 null，卡片显示“—”；接口扩充后只改 `fromContract`。
 */
export type TenantOverview = {
  currency: Currency;
  monthConsumption: string;
  monthCallMinutes: string;
  /** 本月通话数（含未接通）。 */
  monthCallCount: number | null;
  monthUnansweredCount: number | null;
  todayConsumption: string | null;
  dailyConsumption: { date: string; amount: string }[];
};

export function fromContract(
  response: AdminTenantOverviewResponse,
): TenantOverview {
  return {
    currency: response.currency,
    monthConsumption: response.monthConsumption,
    monthCallMinutes: response.monthCallMinutes,
    monthCallCount: null,
    monthUnansweredCount: null,
    todayConsumption: null,
    dailyConsumption: response.dailyConsumption,
  };
}

export function dailyTotal(days: TenantOverview['dailyConsumption']) {
  return days
    .reduce((sum, day) => sum.plus(day.amount), new Decimal(0))
    .toFixed();
}

/** 数据来源；为 null 时概况页显示“数据即将上线”，不发请求。 */
export type TenantOverviewSource = (tenantId: string) => {
  queryKey: readonly unknown[];
  queryFn: () => Promise<TenantOverview>;
};

export function createOverviewSource(
  enabled: boolean,
): TenantOverviewSource | null {
  if (!enabled) return null;
  return (tenantId) => {
    const input = { params: { tenantId } };
    return {
      queryKey: [...apiKey('adminTenantOverview', input), 'view'],
      queryFn: async () =>
        fromContract(await callApi('adminTenantOverview', input)),
    };
  };
}

export const tenantOverviewSource = createOverviewSource(
  webConfig.tenantOverviewEnabled,
);
