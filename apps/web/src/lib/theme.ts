import { useSyncExternalStore } from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const themeOptions = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const satisfies readonly { value: ThemePreference; label: string }[];

/** 与 index.html 中的首屏脚本共用同一个键，避免刷新时闪烁。 */
export const themeStorageKey = 'fs-billing.theme';
const darkQuery = '(prefers-color-scheme: dark)';

function isPreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(themeStorageKey);
    return isPreference(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

const listeners = new Set<() => void>();
let preference: ThemePreference = 'system';

function apply() {
  document.documentElement.dataset['theme'] = resolveTheme(
    preference,
    matchMedia(darkQuery).matches,
  );
}

export function initTheme() {
  preference = readPreference();
  apply();
  matchMedia(darkQuery).addEventListener('change', () => {
    if (preference === 'system') apply();
  });
}

export function setThemePreference(next: ThemePreference) {
  preference = next;
  try {
    localStorage.setItem(themeStorageKey, next);
  } catch {
    // 无法持久化时仍在本次会话生效。
  }
  apply();
  listeners.forEach((listener) => listener());
}

export function useThemePreference() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => preference,
  );
}
