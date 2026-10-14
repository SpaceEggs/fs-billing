import { useSyncExternalStore } from 'react';
import type { SessionResponse } from '@fs-billing/shared';
import { ApiRequestError, callApi, needsReauthentication } from './api';

export const sessionQueryKey = ['session'] as const;

export type SessionState =
  | { status: 'active'; session: SessionResponse }
  | { status: 'signed-out'; expired: boolean }
  | { status: 'blocked'; code: 'ACCOUNT_DISABLED' | 'IDENTITY_UNAVAILABLE' };

export async function loadSession(): Promise<SessionState> {
  try {
    return { status: 'active', session: await callApi('session') };
  } catch (error) {
    if (needsReauthentication(error))
      return {
        status: 'signed-out',
        expired: error.code === 'SESSION_EXPIRED',
      };
    const blocked = blockedCode(error);
    if (blocked) return { status: 'blocked', code: blocked };
    throw error;
  }
}

export function blockedCode(error: unknown) {
  if (!(error instanceof ApiRequestError)) return null;
  return error.code === 'ACCOUNT_DISABLED' ||
    error.code === 'IDENTITY_UNAVAILABLE'
    ? error.code
    : null;
}

/** 页面内的请求收到 reauthenticate 后，弹出“登录已过期”对话框。 */
let expired = false;
const listeners = new Set<() => void>();

export const sessionExpiry = {
  mark() {
    if (expired) return;
    expired = true;
    listeners.forEach((listener) => listener());
  },
  clear() {
    if (!expired) return;
    expired = false;
    listeners.forEach((listener) => listener());
  },
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => expired,
};

export function useSessionExpired() {
  return useSyncExternalStore(sessionExpiry.subscribe, sessionExpiry.get);
}
