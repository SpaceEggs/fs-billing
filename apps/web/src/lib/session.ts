import { useSyncExternalStore } from 'react';
import type { Locale, SessionResponse } from '@fs-billing/shared';
import { setLocale } from '../i18n';
import {
  browserLanguages,
  pickAccountLocale,
  readStoredLocale,
} from '../i18n/detect';
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

export type BlockedCode = Extract<SessionState, { status: 'blocked' }>['code'];

export function blockedCode(error: unknown): BlockedCode | null {
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

// 账号 locale 为 NULL 时只在登录后写一次；同一会话反复进入受保护页面不再重复请求。
const localeSynced = new Set<string>();
// 账号语言只在本次登录后的首次加载采用；之后用户手动切换（即使写入失败）不再被
// 每次导航的会话刷新覆盖，下次登录或刷新页面再以账号值为准。
const accountApplied = new Set<string>();

/**
 * 登录后把语言对齐到账号（docs/i18n-design.md §6.2）：账号有值时以账号为准并写入
 * localStorage；账号为 NULL 时把当前语言写入账号一次。
 */
export async function syncAccountLocale(
  session: SessionResponse,
): Promise<void> {
  const profileId = session.identity.profileId;
  const account = session.identity.locale;
  if (account) {
    if (accountApplied.has(profileId)) return;
    accountApplied.add(profileId);
    setLocale(
      pickAccountLocale(account, readStoredLocale(), browserLanguages()),
    );
    return;
  }
  const locale = pickAccountLocale(
    null,
    readStoredLocale(),
    browserLanguages(),
  );
  setLocale(locale);
  if (localeSynced.has(profileId)) return;
  localeSynced.add(profileId);
  if (!(await saveAccountLocale(locale))) localeSynced.delete(profileId);
}

/**
 * 已登录时切换语言：界面和 localStorage 已经先改好。请求失败不回退界面语言，
 * 也不弹全局错误；下次登录仍以账号值为准。返回是否写入成功。
 */
export async function saveAccountLocale(locale: Locale): Promise<boolean> {
  try {
    await callApi('setAccountLocale', { body: { locale } });
    return true;
  } catch {
    // 同上：静默失败，保留本次界面选择。
    return false;
  }
}

/** 退出登录或重新登录后，下一次会话重新采用账号语言。 */
export function resetAccountLocaleSync(): void {
  localeSynced.clear();
  accountApplied.clear();
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

/**
 * 页面内任一请求返回 ACCOUNT_DISABLED / IDENTITY_UNAVAILABLE 时记下原因；区域布局据此改显示停用页，
 * 不再显示缓存的页面和操作。退出登录或下一次确认会话有效时清除。
 */
export const identityBlock = (() => {
  let value: BlockedCode | null = null;
  const listeners = new Set<() => void>();
  const set = (next: BlockedCode | null) => {
    if (value === next) return;
    value = next;
    listeners.forEach((listener) => listener());
  };
  return {
    mark: (code: BlockedCode) => set(code),
    clear: () => set(null),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => value,
  };
})();

export function useIdentityBlock() {
  return useSyncExternalStore(identityBlock.subscribe, identityBlock.get);
}

export function useSessionExpired() {
  return useSyncExternalStore(sessionExpiry.subscribe, sessionExpiry.get);
}

export function usePasswordChangeRequired() {
  return useSyncExternalStore(passwordGate.subscribe, passwordGate.get);
}
