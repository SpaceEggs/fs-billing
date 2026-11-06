import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { translate, type Locale } from '@fs-billing/shared';
import { currentLocale } from '../i18n';
import { ApiRequestError, callApi } from './api';
import { clearBalanceAttempts } from './balance-attempts';
import {
  identityBlock,
  passwordGate,
  resetAccountLocaleSync,
  sessionExpiry,
} from './session';
import { zones, type Zone } from './zone';

export function logoutFailedMessage(locale: Locale = currentLocale()) {
  return translate(locale, 'auth:logout.failed');
}

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
      clearBalanceAttempts();
      sessionExpiry.clear();
      passwordGate.clear();
      identityBlock.clear();
      resetAccountLocaleSync();
      await router.navigate({ to: zones[zone].login, search: {} });
    },
  });
}
