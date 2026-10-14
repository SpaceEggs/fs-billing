import type { z } from 'zod';
import {
  apiContract,
  apiErrorSchema,
  type ApiError,
  type ApiOperation,
  type ApiOperationId,
} from '@fs-billing/shared';

type Operation<Id extends ApiOperationId> = (typeof apiContract)[Id];
type Responses<Id extends ApiOperationId> = Operation<Id>['responses'];

/** 浏览器调用的操作都没有路径参数；含 `{id}` 的后台操作在后续阶段接入。 */
export type BrowserOperationId = {
  [Id in ApiOperationId]: Operation<Id>['path'] extends `${string}{${string}`
    ? never
    : Id;
}[ApiOperationId];

export type ApiSuccess<Id extends ApiOperationId> = z.output<
  Responses<Id>[Extract<keyof Responses<Id>, 200 | 204>]
>;
export type ApiBody<Id extends ApiOperationId> = z.input<
  Operation<Id>['request']['body']
>;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | null,
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

export async function callApi<Id extends BrowserOperationId>(
  operationId: Id,
  ...[body]: undefined extends ApiBody<Id>
    ? [body?: ApiBody<Id>]
    : [body: ApiBody<Id>]
): Promise<ApiSuccess<Id>> {
  const operation: ApiOperation = apiContract[operationId];
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
  let response: Response;
  try {
    response = await fetch(operation.path, init);
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
    // 契约以 operationId 索引成功 schema；运行时 parse 后的值即该类型。
    return schema.parse(payload) as ApiSuccess<Id>;
  }
  const error = apiErrorSchema.safeParse(payload);
  throw new ApiRequestError(response.status, error.success ? error.data : null);
}
