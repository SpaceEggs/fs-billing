import { DEFAULT_LOCALE, isLocale, type Locale } from '@fs-billing/shared';

/** 与 index.html 的首屏脚本共用同一个键。 */
export const localeStorageKey = 'fs-billing.locale';

export function localeFromLanguage(language: string | undefined): Locale {
  return language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** 登录前只有 localStorage → navigator.languages → 默认值；账号同步属于 I3。 */
export function pickLocale(
  stored: string | null,
  languages: readonly string[] | undefined,
): Locale {
  if (isLocale(stored)) return stored;
  const first = languages?.[0];
  if (first) return localeFromLanguage(first);
  return DEFAULT_LOCALE;
}

export function readStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(localeStorageKey);
    return isLocale(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function writeStoredLocale(locale: Locale): void {
  try {
    localStorage.setItem(localeStorageKey, locale);
  } catch {
    // 无法持久化时仍在本次会话生效。
  }
}

export function browserLanguages(): readonly string[] | undefined {
  if (typeof navigator === 'undefined') return undefined;
  if (navigator.languages.length > 0) return navigator.languages;
  return navigator.language ? [navigator.language] : undefined;
}

export function detectLocale(): Locale {
  return pickLocale(readStoredLocale(), browserLanguages());
}

export function htmlLang(locale: Locale): 'zh-CN' | 'en' {
  return locale === 'zh' ? 'zh-CN' : 'en';
}
