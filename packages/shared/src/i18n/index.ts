export const LOCALES = ['zh', 'en'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'zh';

/** 切换菜单里的语言名用各自原文，不翻译。 */
export const LOCALE_NAMES = {
  zh: '中文',
  en: 'English',
} as const satisfies Record<Locale, string>;

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export { en } from './en/index.js';
export { zh } from './zh/index.js';
export type { DeepSameShape } from './types.js';
