import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { ApiRequestError, callApi } from './api';
import { sessionExpiry } from './session';
import { zones, type Zone } from './zone';

export const logoutFailedMessage = '退出失败，请检查网络后重试';

/**
 * 服务器确认退出后才清除缓存并回到登录页；会话已失效（401）也视为已退出。
 * 其他失败保留当前会话，由调用方显示 logoutFailedMessage 供用户重试。
 */
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
    onSuccess: async () => {
      queryClient.clear();
      sessionExpiry.clear();
      await router.navigate({ to: zones[zone].login, search: {} });
    },
  });
}
