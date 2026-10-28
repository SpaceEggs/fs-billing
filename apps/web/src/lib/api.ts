import type { z } from 'zod';
import {
  adminApiContract,
  adminApiErrorSchema,
  adminCdrApiContract,
  adminStatementApiContract,
  adminUnassignedApiContract,
  adminCdrDeletionApiContract,
  adminAuditLogApiContract,
  apiContract,
  portalApiContract,
  type AdminApiError,
  type ApiOperation,
} from '@fs-billing/shared';
import { downloadBlob } from './download';

const { adminTenantCdrsExport, ...adminCdrQueries } = adminCdrApiContract;
const { adminTenantStatementExport, ...adminStatementQueries } =
  adminStatementApiContract;
const {
  portalCdrsExport,
  portalLedgerExport,
  portalStatementExport,
  ...portalQueries
} = portalApiContract;

/**
 * 浏览器经 callApi 调用的 JSON 操作：阶段 4 认证与上下文，阶段 5 后台契约，阶段 6 门户与后台话单查询，阶段 7 月账单，阶段 8 未归属话单、删除话单与操作日志。
 * 导出的响应是 CSV 文本，不能按 JSON 解析，只放在 downloadApiContract 里，类型上无法交给 callApi。
 */
export const webApiContract = {
  ...apiContract,
  ...adminApiContract,
  ...adminCdrQueries,
  ...adminStatementQueries,
  ...adminUnassignedApiContract,
  ...adminCdrDeletionApiContract,
  ...adminAuditLogApiContract,
  ...portalQueries,
};
/** 响应为文件的操作，经 callDownload 调用。 */
export const downloadApiContract = {
  adminTenantCdrsExport,
  adminTenantStatementExport,
  portalCdrsExport,
  portalLedgerExport,
  portalStatementExport,
};
export type DownloadOperationId = keyof typeof downloadApiContract;
export type OperationId = keyof typeof webApiContract;
type Operation<Id extends OperationId> = (typeof webApiContract)[Id];
type Request<Id extends OperationId> = Operation<Id>['request'];
type Responses<Id extends OperationId> = Operation<Id>['responses'];

export type ApiSuccess<Id extends OperationId> = z.output<
  Responses<Id>[Extract<keyof Responses<Id>, 200 | 204>]
>;

/** 没有必填字段的部分可以省略，例如空 params、全部可选的 query。 */
type Part<Key extends string, Value> = undefined extends Value
  ? { [K in Key]?: Value }
  : Record<never, never> extends Value
    ? { [K in Key]?: Value }
    : { [K in Key]: Value };
export type ApiInput<Id extends OperationId> = Part<
  'params',
  z.input<Request<Id>['params']>
> &
  Part<'query', z.input<Request<Id>['query']>> &
  Part<'body', z.input<Request<Id>['body']>>;
export type ApiBody<Id extends OperationId> = z.input<Request<Id>['body']>;
export type ApiQuery<Id extends OperationId> = z.input<Request<Id>['query']>;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: AdminApiError | null,
    options?: ErrorOptions,
  ) {
    super(
      body?.error.message ?? `API request failed with status ${status}`,
      options,
    );
    this.name = 'ApiRequestError';
  }

  get code() {
    return this.body?.error.code ?? null;
  }

  /**
   * 不知道服务端是否已执行：请求没有得到响应（status 0），
   * 或成功状态的响应体读不出、不符合契约（连接在读响应体时中断）。写操作须先刷新核实再提交。
   */
  get outcomeUnknown() {
    return this.status === 0 || (this.status >= 200 && this.status < 300);
  }
}

export function needsReauthentication(
  error: unknown,
): error is ApiRequestError {
  return (
    error instanceof ApiRequestError &&
    error.status === 401 &&
    error.body !== null &&
    'action' in error.body.error &&
    error.body.error.action === 'reauthenticate'
  );
}

export function apiPath(
  operation: ApiOperation,
  input: { params?: unknown; query?: unknown },
) {
  const params = operation.request.params.parse(input.params ?? {}) as Record<
    string,
    string
  >;
  const path = operation.path.replaceAll(/\{([^}]+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ''),
  );
  const query = operation.request.query.parse(input.query ?? {}) as Record<
    string,
    unknown
  >;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    )
      search.set(key, String(value));
  const queryString = search.toString();
  return queryString ? `${path}?${queryString}` : path;
}

/**
 * 按契约调用：请求在发送前用请求 schema 解析（含编码大写、邮箱去重等规范化），
 * 成功响应按状态码 schema 解析，失败响应解析为后台错误联合。
 */
export function callApi<Id extends OperationId>(
  operationId: Id,
  ...[input]: Record<never, never> extends ApiInput<Id>
    ? [input?: ApiInput<Id>]
    : [input: ApiInput<Id>]
): Promise<ApiSuccess<Id>> {
  // 契约以 operationId 索引成功 schema；运行时 parse 后的值即该类型。
  return callOperation(webApiContract[operationId], input ?? {}) as Promise<
    ApiSuccess<Id>
  >;
}

/** 按任意契约操作发送请求；返回值已由该操作的成功 schema 解析。 */
export async function callOperation(
  operation: ApiOperation,
  input: { params?: unknown; query?: unknown; body?: unknown },
): Promise<unknown> {
  const { params, query, body } = input;
  const headers: Record<string, string> = { accept: 'application/json' };
  const init: RequestInit = {
    method: operation.method,
    headers,
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(operation.request.body.parse(body));
  }
  const url = apiPath(operation, { params, query });
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new ApiRequestError(0, null);
  }
  const schema = operation.responses[response.status];
  if (response.ok) {
    if (!schema) throw new ApiRequestError(response.status, null);
    let payload: unknown;
    try {
      payload = response.status === 204 ? undefined : await response.json();
    } catch (cause) {
      throw new ApiRequestError(response.status, null, { cause });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success)
      throw new ApiRequestError(response.status, null, {
        cause: parsed.error,
      });
    return parsed.data;
  }
  throw await failedResponse(response);
}

async function failedResponse(response: Response) {
  const payload: unknown = await response.json().catch(() => undefined);
  const error = adminApiErrorSchema.safeParse(payload);
  return new ApiRequestError(
    response.status,
    error.success ? error.data : null,
  );
}

type DownloadRequest<Id extends DownloadOperationId> =
  (typeof downloadApiContract)[Id]['request'];
export type DownloadInput<Id extends DownloadOperationId> = Part<
  'params',
  z.input<DownloadRequest<Id>['params']>
> & { body: z.input<DownloadRequest<Id>['body']> };

const fallbackFilename = 'export.csv';

/** 取 Content-Disposition 里的文件名；服务端文件名只含 ASCII 字母数字与 `._-`，其余一律不信任。 */
export function downloadFilename(disposition: string | null) {
  const name = /filename="([^"\\]+)"/.exec(disposition ?? '')?.[1];
  return name && /^[A-Za-z0-9._-]+$/.test(name) ? name : fallbackFilename;
}

/**
 * 导出文件：POST 当前筛选，整个响应读完（blob）后才保存。服务端在开始写出后失败会销毁连接，
 * fetch 或 blob() 因此拒绝，抛 `ApiRequestError(0)`，不保存任何内容。
 * 失败的响应与 callApi 一样解析为 `ApiRequestError`。
 */
export async function callDownload<Id extends DownloadOperationId>(
  operationId: Id,
  input: DownloadInput<Id>,
): Promise<{ filename: string }> {
  const operation: ApiOperation = downloadApiContract[operationId];
  const body = operation.request.body.parse(input.body);
  const url = apiPath(operation, {
    params: (input as { params?: unknown }).params,
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: operation.method,
      headers: {
        accept: 'text/csv, application/json',
        'content-type': 'application/json',
      },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, null);
  }
  if (!response.ok) throw await failedResponse(response);
  if (!response.headers.get('content-type')?.startsWith('text/csv'))
    throw new ApiRequestError(response.status, null);
  const filename = downloadFilename(
    response.headers.get('content-disposition'),
  );
  let blob: Blob;
  try {
    blob = await response.blob();
  } catch {
    throw new ApiRequestError(0, null);
  }
  downloadBlob(filename, blob);
  return { filename };
}
