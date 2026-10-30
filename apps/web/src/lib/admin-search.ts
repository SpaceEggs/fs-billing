import { z } from 'zod';
import {
  adminAuditLogsQuerySchema,
  adminLedgerKindSchema,
  adminPageQuerySchema,
  adminReceivablesQuerySchema,
  adminTenantsQuerySchema,
  adminUnassignedListQuerySchema,
  dayRangeFields,
  statementMonthSchema,
  type AuditLabel,
} from '@fs-billing/shared';
import { validateCdrFilters, type CdrFilters } from './cdr-search';

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
  { key: 'cdrs', label: '话单' },
  { key: 'statements', label: '账单' },
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

/** 话单标签页自己的日期范围；余额流水用 from / to，两页的范围互不影响。 */
export type CdrTabRange = {
  cdrFrom?: string | undefined;
  cdrTo?: string | undefined;
};

/** 账单标签页自己的参数：打开某个月账单详情时是 YYYY-MM，没有则显示账单列表；与流水、话单的日期范围无关。 */
export type StatementTabSearch = {
  statementMonth?: string | undefined;
};

/**
 * 租户详情的地址状态：余额流水的日期范围是 from / to，话单标签页的是 cdrFrom / cdrTo，
 * 各用各的范围（决定 40）；账单标签页用自己的 statementMonth。话单标签页的其他筛选见 CdrFilters；
 * 页码与余额流水共用同一个键，切换标签页时由标签链接清除。
 */
export type TenantDetailSearch = LedgerSearch &
  CdrFilters &
  CdrTabRange &
  StatementTabSearch & {
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
    cdrFrom: dayRangeFields.from.safeParse(raw['cdrFrom']).data,
    cdrTo: dayRangeFields.to.safeParse(raw['cdrTo']).data,
    statementMonth: statementMonthSchema.safeParse(raw['statementMonth']).data,
    kind: adminLedgerKindSchema.safeParse(raw['kind']).data,
    ...validateCdrFilters(raw),
    page: pageOf(raw['page']),
  };
}

/** 后台账单页的月份；缺省（上一个北京月）不写入地址，晚于上月的值由页面收回到上月。 */
export type AdminStatementsSearch = {
  month?: string | undefined;
};

export function validateAdminStatementsSearch(
  raw: Record<string, unknown>,
): AdminStatementsSearch {
  return { month: statementMonthSchema.safeParse(raw['month']).data };
}

/**
 * 未归属话单：默认待处理不写入地址。`tag` 不传是全部分组，空串是「标签为空」。
 * 路由会把纯数字查询串收成 number（`"326"` → 326），这里还原成字符串，否则数字标签会被丢掉。
 */
export type UnassignedSearch = {
  tab?: 'ignored' | undefined;
  reason?: string | undefined;
  tag?: string | undefined;
  page?: number | undefined;
};

function unassignedTagOf(raw: unknown) {
  const value =
    typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw;
  return adminUnassignedListQuerySchema.shape.tag.safeParse(value).data;
}

export function validateUnassignedSearch(
  raw: Record<string, unknown>,
): UnassignedSearch {
  return {
    tab: raw['tab'] === 'ignored' ? 'ignored' : undefined,
    tag: unassignedTagOf(raw['tag']),
    reason: adminUnassignedListQuerySchema.shape.reason.safeParse(raw['reason'])
      .data,
    page: pageOf(raw['page']),
  };
}

/**
 * 操作日志：日期、管理员、操作标签、租户与页码。默认最近 30 天不写入地址。
 * 两端都是合法日期但开始晚于结束时丢掉 `to`（契约把错误记在 to 上），避免整段查询被拒。
 */
export type AuditLogSearch = {
  from?: string | undefined;
  to?: string | undefined;
  adminId?: string | undefined;
  label?: AuditLabel | undefined;
  tenantId?: string | undefined;
  page?: number | undefined;
};

export function validateAuditLogSearch(
  raw: Record<string, unknown>,
): AuditLogSearch {
  const shape = adminAuditLogsQuerySchema.shape;
  const from = shape.from.safeParse(raw['from']).data;
  let to = shape.to.safeParse(raw['to']).data;
  if (from !== undefined && to !== undefined && from > to) to = undefined;
  return {
    from,
    to,
    adminId: shape.adminId.safeParse(raw['adminId']).data,
    label: shape.label.safeParse(raw['label']).data,
    tenantId: shape.tenantId.safeParse(raw['tenantId']).data,
    page: pageOf(raw['page']),
  };
}
