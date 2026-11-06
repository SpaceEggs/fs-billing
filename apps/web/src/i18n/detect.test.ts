import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectLocale,
  htmlLang,
  localeFromLanguage,
  localeStorageKey,
  pickAccountLocale,
  pickLocale,
  readStoredLocale,
  writeStoredLocale,
} from './detect';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pickLocale', () => {
  it('uses a stored zh or en locale first', () => {
    expect(pickLocale('zh', ['en-US'])).toBe('zh');
    expect(pickLocale('en', ['zh-CN'])).toBe('en');
  });

  it('ignores an invalid stored locale', () => {
    expect(pickLocale('ja', ['zh-CN'])).toBe('zh');
    expect(pickLocale('EN', ['zh-CN'])).toBe('zh');
  });

  it('maps zh-* to Chinese and every other language to English', () => {
    expect(localeFromLanguage('zh')).toBe('zh');
    expect(localeFromLanguage('zh-CN')).toBe('zh');
    expect(localeFromLanguage('zh-TW')).toBe('zh');
    expect(localeFromLanguage('ja')).toBe('en');
    expect(localeFromLanguage('en-US')).toBe('en');
    expect(localeFromLanguage(undefined)).toBe('en');
  });

  it('uses the first browser language when nothing is stored', () => {
    expect(pickLocale(null, ['ja-JP', 'zh-CN'])).toBe('en');
    expect(pickLocale(null, ['zh-HK', 'en-US'])).toBe('zh');
  });

  it('falls back to Chinese when there is no browser language', () => {
    expect(pickLocale(null, undefined)).toBe('zh');
    expect(pickLocale(null, [])).toBe('zh');
  });
});

describe('pickAccountLocale', () => {
  it('prefers the account locale over localStorage and the browser', () => {
    expect(pickAccountLocale('en', 'zh', ['zh-CN'])).toBe('en');
    expect(pickAccountLocale('zh', 'en', ['en-US'])).toBe('zh');
  });

  it('falls back to localStorage, browser language, then Chinese', () => {
    expect(pickAccountLocale(null, 'en', ['zh-CN'])).toBe('en');
    expect(pickAccountLocale(undefined, null, ['zh-HK'])).toBe('zh');
    expect(pickAccountLocale(null, null, ['ja-JP'])).toBe('en');
    expect(pickAccountLocale(null, null, undefined)).toBe('zh');
    expect(pickAccountLocale('ja', null, ['en-US'])).toBe('en');
  });
});

describe('stored locale', () => {
  it('writes and reads only supported locales', () => {
    writeStoredLocale('en');
    expect(localStorage.getItem(localeStorageKey)).toBe('en');
    expect(readStoredLocale()).toBe('en');
    localStorage.setItem(localeStorageKey, 'ja');
    expect(readStoredLocale()).toBeNull();
  });

  it('keeps working when localStorage throws', () => {
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    const setItem = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('blocked');
      });
    expect(readStoredLocale()).toBeNull();
    expect(() => writeStoredLocale('en')).not.toThrow();
    getItem.mockRestore();
    setItem.mockRestore();
  });

  it('detects the stored locale before the browser languages', () => {
    localStorage.setItem(localeStorageKey, 'en');
    expect(detectLocale()).toBe('en');
  });
});

describe('htmlLang', () => {
  it('uses zh-CN for Chinese and en otherwise', () => {
    expect(htmlLang('zh')).toBe('zh-CN');
    expect(htmlLang('en')).toBe('en');
  });
});
