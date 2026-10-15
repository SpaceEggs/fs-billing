import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiRequestError, needsReauthentication } from './lib/api';
import {
  passwordGate,
  requiresPasswordChange,
  sessionExpiry,
} from './lib/session';

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error) => {
        if (needsReauthentication(error)) sessionExpiry.mark();
        if (requiresPasswordChange(error)) passwordGate.mark();
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
