import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ApiRequestError, callApi } from './api';
import { sessionExpiry } from './session';
import { zones, type Zone } from './zone';

/** 退出后清除所有缓存的身份与受保护数据；会话已失效（401）也视为已退出。 */
export function useLogout(zone: Zone) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    meta: { ignoreReauthentication: true },
    mutationFn: async () => {
      try {
        await callApi('logout');
      } catch (error) {
        if (!(error instanceof ApiRequestError && error.status === 401))
          throw error;
      }
    },
    onSettled: async () => {
      queryClient.clear();
      sessionExpiry.clear();
      await router.navigate({ to: zones[zone].login, search: {} });
    },
  });
}
