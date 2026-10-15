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

export function requiresPasswordChange(error: unknown) {
  return (
    error instanceof ApiRequestError &&
    error.code === 'PASSWORD_CHANGE_REQUIRED'
  );
}

function createFlag() {
  let value = false;
  const listeners = new Set<() => void>();
  const set = (next: boolean) => {
    if (value === next) return;
    value = next;
    listeners.forEach((listener) => listener());
  };
  return {
    mark: () => set(true),
    clear: () => set(false),
    set,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => value,
  };
}

/** 页面内的请求收到 reauthenticate 后，弹出“登录已过期”对话框。 */
export const sessionExpiry = createFlag();

/**
 * 会话带 passwordChangeRequired，或任一请求返回 403 PASSWORD_CHANGE_REQUIRED 时置位；
 * 根组件据此跳转到所在区域的改密页，改密成功后清除。
 */
export const passwordGate = createFlag();

export function useSessionExpired() {
  return useSyncExternalStore(sessionExpiry.subscribe, sessionExpiry.get);
}

export function usePasswordChangeRequired() {
  return useSyncExternalStore(passwordGate.subscribe, passwordGate.get);
}
