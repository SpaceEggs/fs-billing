import type { z } from 'zod';
import {
  adminApiContract,
  adminApiErrorSchema,
  apiContract,
  type AdminApiError,
  type ApiOperation,
} from '@fs-billing/shared';

/** 浏览器可调用的全部操作：阶段 4 认证与上下文，加阶段 5 后台契约。 */
export const webApiContract = { ...apiContract, ...adminApiContract };
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
  ) {
    super(body?.error.message ?? `API request failed with status ${status}`);
    this.name = 'ApiRequestError';
  }

  get code() {
    return this.body?.error.code ?? null;
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
  const payload: unknown =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  const schema = operation.responses[response.status];
  if (response.ok) {
    if (!schema) throw new ApiRequestError(response.status, null);
    return schema.parse(payload);
  }
  const error = adminApiErrorSchema.safeParse(payload);
  throw new ApiRequestError(response.status, error.success ? error.data : null);
}
