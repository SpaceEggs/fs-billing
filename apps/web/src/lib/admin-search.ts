import { z } from 'zod';
import {
  adminAccountsQuerySchema,
  adminLedgerKindSchema,
  adminPageQuerySchema,
  adminReceivablesQuerySchema,
  adminTenantsQuerySchema,
} from '@fs-billing/shared';

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

export type AdminAccountsSearch = { search?: string; page?: number };

export function validateAdminAccountsSearch(
  raw: Record<string, unknown>,
): AdminAccountsSearch {
  const shape = adminAccountsQuerySchema.shape;
  const search = shape.search.safeParse(raw['search']).data;
  const page = shape.page.safeParse(raw['page']).data;
  return {
    ...(search?.trim() ? { search } : {}),
    ...(page !== undefined && page > 1 ? { page } : {}),
  };
}

export type ReceivablesSearch = {
  /** 默认 pending，不写入地址。 */
  status?: 'received' | 'voided';
  search?: string;
  currency?: z.infer<typeof adminReceivablesQuerySchema.shape.currency>;
  page?: number;
};

export function validateReceivablesSearch(
  raw: Record<string, unknown>,
): ReceivablesSearch {
  const shape = adminReceivablesQuerySchema.shape;
  const search = shape.search.safeParse(raw['search']).data;
  const currency = shape.currency.safeParse(raw['currency']).data;
  const page = shape.page.safeParse(raw['page']).data;
  const status = shape.status.safeParse(raw['status']).data;
  return {
    ...(status === 'received' || status === 'voided' ? { status } : {}),
    ...(search?.trim() ? { search } : {}),
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

/**
 * 路由保留校验结果中缺少的原始参数，所以非法值显式置为 undefined 丢弃。
 */
export function validateTenantDetailSearch(
  raw: Record<string, unknown>,
): TenantDetailSearch {
  const tab = tenantTabs.find(({ key }) => key === raw['tab'])?.key;
  const page = adminPageQuerySchema.shape.page.safeParse(raw['page']).data;
  return {
    tab: tab === 'overview' ? undefined : tab,
    from: z.iso.date().safeParse(raw['from']).data,
    to: z.iso.date().safeParse(raw['to']).data,
    kind: adminLedgerKindSchema.safeParse(raw['kind']).data,
    page: page !== undefined && page > 1 ? page : undefined,
  };
}
