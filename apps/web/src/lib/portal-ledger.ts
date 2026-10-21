import {
  adminApiErrorSchema,
  dayRangeFields,
  pageNumberSchema,
  portalLedgerApiContract,
  portalLedgerExportApiContract,
  portalLedgerKindSchema,
  type PortalLedgerKind,
  type PortalLedgerResponse,
} from '@fs-billing/shared';
import { ApiRequestError, callOperation } from './api';

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

export function portalLedgerKey(filter: PortalLedgerFilter, page: number) {
  return ['portal', 'ledger', filter, page] as const;
}

/**
 * 契约尚未并入 webApiContract（PR 4、5 也在改那一行），这里直接按门户契约调用；
 * callOperation 已用响应 schema 解析。
 */
export function fetchPortalLedger(filter: PortalLedgerFilter, page: number) {
  return callOperation(portalLedgerApiContract.portalLedger, {
    query: { ...filter, page },
  }) as Promise<PortalLedgerResponse>;
}

/** 当天话单的地址：门户话单页（PR 5）按 from、to 取北京日范围。 */
export function cdrDayHref(day: string) {
  return `/portal/cdrs?from=${day}&to=${day}`;
}

function filenameOf(response: Response) {
  const header = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(header)?.[1] ?? 'ledger.csv';
}

/** 保存 Blob；PR 5 的 lib/download.ts 提供 downloadBlob 后改用它。 */
function saveBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * 流水 CSV：POST 当前筛选，整份读入内存后保存。网络中断或读取中断抛 ApiRequestError(0)，
 * 不保存任何内容；PR 5 的 callDownload 到位后改用它。
 */
export async function exportPortalLedger(filter: PortalLedgerFilter) {
  const operation = portalLedgerExportApiContract.portalLedgerExport;
  let response: Response;
  try {
    response = await fetch(operation.path, {
      method: operation.method,
      headers: {
        accept: 'text/csv',
        'content-type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(operation.request.body.parse(filter)),
    });
  } catch {
    throw new ApiRequestError(0, null);
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => undefined);
    const error = adminApiErrorSchema.safeParse(payload);
    throw new ApiRequestError(
      response.status,
      error.success ? error.data : null,
    );
  }
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ApiRequestError(0, null);
  }
  saveBlob(filenameOf(response), blob);
}
