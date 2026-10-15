import { z } from 'zod';
import { adminTenantsQuerySchema } from '@fs-billing/shared';

const listShape = adminTenantsQuerySchema.shape;

/** 租户列表地址参数：非法值单独丢弃，不让一个错参数清空其余筛选。 */
export type TenantListSearch = {
  search?: string;
  status?: z.infer<typeof listShape.status>;
  currency?: z.infer<typeof listShape.currency>;
  page?: number;
};

export function validateTenantListSearch(
  raw: Record<string, unknown>,
): TenantListSearch {
  const search = listShape.search.safeParse(raw['search']).data;
  const status = listShape.status.safeParse(raw['status']).data;
  const currency = listShape.currency.safeParse(raw['currency']).data;
  const page = listShape.page.safeParse(raw['page']).data;
  return {
    ...(search?.trim() ? { search } : {}),
    ...(status ? { status } : {}),
    ...(currency ? { currency } : {}),
    ...(page !== undefined && page > 1 ? { page } : {}),
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

export function validateTenantDetailSearch(raw: Record<string, unknown>): {
  tab?: TenantTab;
} {
  const tab = tenantTabs.find(({ key }) => key === raw['tab'])?.key;
  return tab && tab !== 'overview' ? { tab } : {};
}
