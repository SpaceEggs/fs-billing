import {
  queryOptions,
  useMutation,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  callApi,
  type ApiInput,
  type ApiSuccess,
  type OperationId,
} from './api';

/** 查询键即 operationId 加原样输入，同一操作的所有页、筛选共享前缀。 */
export function apiKey<Id extends OperationId>(id: Id, input?: ApiInput<Id>) {
  return ['api', id, input ?? {}] as const;
}

function send<Id extends OperationId>(id: Id, input?: ApiInput<Id>) {
  // callApi 的剩余参数按是否有必填字段区分可省略；这里输入已由调用方按 ApiInput 约束。
  return (callApi as (id: Id, input?: ApiInput<Id>) => Promise<ApiSuccess<Id>>)(
    id,
    input,
  );
}

export function apiQuery<Id extends OperationId>(
  id: Id,
  ...[input]: Record<never, never> extends ApiInput<Id>
    ? [input?: ApiInput<Id>]
    : [input: ApiInput<Id>]
) {
  return queryOptions({
    queryKey: apiKey(id, input),
    queryFn: () => send(id, input),
  });
}

/** 与租户相关的数据：列表、待收款汇总，以及 params.tenantId 等于该租户的所有查询。 */
export function invalidateTenant(queryClient: QueryClient, tenantId: string) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      if (queryKey[0] !== 'api') return false;
      if (queryKey[1] === 'adminTenants' || queryKey[1] === 'adminReceivables')
        return true;
      const input = queryKey[2] as { params?: { tenantId?: string } };
      return input.params?.tenantId === tenantId;
    },
  });
}

/**
 * 写操作不自动重试：开户、账号创建没有可重放的凭据响应，余额操作由调用方复用幂等键重试。
 * `invalidate` 返回成功后需要刷新的查询。
 */
export function useApiMutation<Id extends OperationId>(
  id: Id,
  options: {
    invalidate?: (
      queryClient: QueryClient,
      input: ApiInput<Id>,
      result: ApiSuccess<Id>,
    ) => Promise<void>;
  } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ApiInput<Id>) => send(id, input),
    onSuccess: (result, input) =>
      options.invalidate?.(queryClient, input, result),
  });
}
