import i18n from 'i18next';
import { initReactI18next, useTranslation } from 'react-i18next';
import {
  DEFAULT_LOCALE,
  en,
  isLocale,
  LOCALES,
  zh,
  type Locale,
} from '@fs-billing/shared';
import { detectLocale, htmlLang, writeStoredLocale } from './detect';

const resources = {
  zh: {
    common: zh.common,
    auth: zh.auth,
    errors: zh.errors,
    enums: zh.enums,
    csv: zh.csv,
    format: zh.format,
    portal: zh.portal,
    statement: zh.statement,
    shell: zh.shell,
    cdr: zh.cdr,
  },
  en: {
    common: en.common,
    auth: en.auth,
    errors: en.errors,
    enums: en.enums,
    csv: en.csv,
    format: en.format,
    portal: en.portal,
    statement: en.statement,
    shell: en.shell,
    cdr: en.cdr,
  },
} as const;

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: typeof zh;
  }
}

let started = false;

function applyDocumentLang(language: string | undefined): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = htmlLang(
    isLocale(language) ? language : DEFAULT_LOCALE,
  );
}

export function initI18n() {
  if (started) return i18n;
  started = true;
  i18n.on('languageChanged', applyDocumentLang);
  void i18n.use(initReactI18next).init({
    resources,
    lng: detectLocale(),
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...LOCALES],
    ns: [
      'common',
      'auth',
      'errors',
      'enums',
      'csv',
      'format',
      'portal',
      'statement',
      'shell',
      'cdr',
    ],
    defaultNS: 'common',
    initAsync: false,
    interpolation: { escapeValue: false },
  });
  applyDocumentLang(i18n.language);
  return i18n;
}

/** 切换界面语言并写入 localStorage；已登录时同步账号由 lib/session 负责。 */
export function setLocale(locale: Locale): void {
  writeStoredLocale(locale);
  void i18n.changeLanguage(locale);
}

export function currentLocale(): Locale {
  return isLocale(i18n.resolvedLanguage)
    ? i18n.resolvedLanguage
    : DEFAULT_LOCALE;
}

export function useLocale(): Locale {
  const { i18n: instance } = useTranslation();
  return isLocale(instance.resolvedLanguage)
    ? instance.resolvedLanguage
    : DEFAULT_LOCALE;
}

export { i18n };
