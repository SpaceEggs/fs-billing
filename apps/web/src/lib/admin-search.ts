import { z } from 'zod';
import {
  adminLedgerKindSchema,
  adminPageQuerySchema,
  adminReceivablesQuerySchema,
  adminTenantsQuerySchema,
  dayRangeFields,
} from '@fs-billing/shared';

const listShape = adminTenantsQuerySchema.shape;

/** 列表页码：缺省或第 1 页不写入地址。 */
function pageOf(raw: unknown) {
  const page = adminPageQuerySchema.shape.page.safeParse(raw).data;
  return page !== undefined && page > 1 ? page : undefined;
}

function searchOf(raw: unknown) {
  const search = listShape.search.safeParse(raw).data;
  return search?.trim() ? search : undefined;
}

/**
 * 地址参数校验：非法值单独丢弃，不让一个错参数清空其余筛选。
 * 路由会保留校验结果中缺少的原始参数，所以每个键都显式返回，非法时为 undefined。
 */
export type TenantListSearch = {
  search?: string | undefined;
  status?: z.infer<typeof listShape.status> | undefined;
  currency?: z.infer<typeof listShape.currency> | undefined;
  page?: number | undefined;
};

export function validateTenantListSearch(
  raw: Record<string, unknown>,
): TenantListSearch {
  return {
    search: searchOf(raw['search']),
    status: listShape.status.safeParse(raw['status']).data,
    currency: listShape.currency.safeParse(raw['currency']).data,
    page: pageOf(raw['page']),
  };
}

export type AdminAccountsSearch = {
  search?: string | undefined;
  page?: number | undefined;
};

export function validateAdminAccountsSearch(
  raw: Record<string, unknown>,
): AdminAccountsSearch {
  return { search: searchOf(raw['search']), page: pageOf(raw['page']) };
}

export type ReceivablesSearch = {
  /** 默认 pending，不写入地址。 */
  status?: 'received' | 'voided' | undefined;
  search?: string | undefined;
  currency?:
    z.infer<typeof adminReceivablesQuerySchema.shape.currency> | undefined;
  page?: number | undefined;
};

export function validateReceivablesSearch(
  raw: Record<string, unknown>,
): ReceivablesSearch {
  const shape = adminReceivablesQuerySchema.shape;
  const status = shape.status.safeParse(raw['status']).data;
  return {
    status: status === 'received' || status === 'voided' ? status : undefined,
    search: searchOf(raw['search']),
    currency: shape.currency.safeParse(raw['currency']).data,
    page: pageOf(raw['page']),
  };
}

export const tenantTabs = [
  { key: 'overview', label: '概况' },
  { key: 'ledger', label: '余额流水' },
  { key: 'rates', label: '费率' },
  { key: 'settings', label: '设置' },
  { key: 'portal', label: '门户账号' },
] as const;
export type TenantTab = (typeof tenantTabs)[number]['key'];

/** 余额流水筛选：北京时间日期（YYYY-MM-DD，含两端）、类型与页码，切换标签页时保留。 */
export type LedgerSearch = {
  from?: string | undefined;
  to?: string | undefined;
  kind?: z.infer<typeof adminLedgerKindSchema> | undefined;
  page?: number | undefined;
};

export type TenantDetailSearch = LedgerSearch & {
  tab?: TenantTab | undefined;
};

export function validateTenantDetailSearch(
  raw: Record<string, unknown>,
): TenantDetailSearch {
  const tab = tenantTabs.find(({ key }) => key === raw['tab'])?.key;
  return {
    tab: tab === 'overview' ? undefined : tab,
    from: dayRangeFields.from.safeParse(raw['from']).data,
    to: dayRangeFields.to.safeParse(raw['to']).data,
    kind: adminLedgerKindSchema.safeParse(raw['kind']).data,
    page: pageOf(raw['page']),
  };
}
