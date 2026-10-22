import {
  dayRangeFields,
  pageNumberSchema,
  portalLedgerKindSchema,
  type PortalLedgerKind,
} from '@fs-billing/shared';

/** 门户流水页的地址状态：北京日范围、类型与页码，刷新与登录过期后保留。 */
export type PortalLedgerSearch = {
  from?: string | undefined;
  to?: string | undefined;
  kind?: PortalLedgerKind | undefined;
  page?: number | undefined;
};

/** 非法值单独丢弃，不让一个错参数清空其余筛选；第 1 页不写入地址。 */
export function validatePortalLedgerSearch(
  raw: Record<string, unknown>,
): PortalLedgerSearch {
  const page = pageNumberSchema.safeParse(raw['page']).data;
  return {
    from: dayRangeFields.from.safeParse(raw['from']).data,
    to: dayRangeFields.to.safeParse(raw['to']).data,
    kind: portalLedgerKindSchema.safeParse(raw['kind']).data,
    page: page !== undefined && page > 1 ? page : undefined,
  };
}

export const portalLedgerKindLabels = {
  recharge: '充值',
  gift: '赠送',
  adjustment: '调账',
  call_charge: '通话扣费',
} as const satisfies Record<PortalLedgerKind, string>;

export type PortalLedgerFilter = {
  from: string;
  to: string;
  kind?: PortalLedgerKind | undefined;
};

/** 当天话单的地址：门户话单页按 from、to 取北京日范围。 */
export function cdrDayHref(day: string) {
  return `/portal/cdrs?from=${day}&to=${day}`;
}
