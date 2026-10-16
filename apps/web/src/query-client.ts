import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiRequestError, needsReauthentication } from './lib/api';
import {
  blockedCode,
  identityBlock,
  passwordGate,
  requiresPasswordChange,
  sessionExpiry,
} from './lib/session';

function markIdentityBlock(error: unknown) {
  const code = blockedCode(error);
  if (code) identityBlock.mark(code);
}

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (needsReauthentication(error)) sessionExpiry.mark();
        if (requiresPasswordChange(error)) passwordGate.mark();
        markIdentityBlock(error);
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (
          needsReauthentication(error) &&
          !mutation.meta?.['ignoreReauthentication']
        )
          sessionExpiry.mark();
        if (requiresPasswordChange(error)) passwordGate.mark();
        // 登录、退出自行说明账号停用，不切换到停用页。
        if (!mutation.meta?.['ignoreReauthentication'])
          markIdentityBlock(error);
      },
    }),
    defaultOptions: {
      queries: {
        retry: (failureCount, error) =>
          !(
            error instanceof ApiRequestError &&
            error.status >= 400 &&
            error.status < 500
          ) && failureCount < 2,
      },
    },
  });
}
