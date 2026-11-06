import type { SessionResponse } from '@fs-billing/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  localeStorageKey,
  readStoredLocale,
  writeStoredLocale,
} from '../i18n/detect';
import { saveAccountLocale, syncAccountLocale } from './session';

function session(locale: 'zh' | 'en' | null): SessionResponse {
  return {
    identity: {
      kind: 'customer',
      profileId: crypto.randomUUID(),
      email: 'customer@example.com',
      locale,
      tenant: {
        id: crypto.randomUUID(),
        code: 'ABC001',
        name: 'Tenant',
        currency: 'CNY',
      },
    },
    expiresAt: '2026-10-21T00:00:00.000Z',
    passwordChangeRequired: false,
  };
}

function respond204() {
  return vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('syncAccountLocale', () => {
  it('uses the account locale and writes it to localStorage without posting', async () => {
    const fetchMock = respond204();
    vi.stubGlobal('fetch', fetchMock);
    writeStoredLocale('zh');

    await syncAccountLocale(session('en'));

    expect(readStoredLocale()).toBe('en');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not re-apply the account locale after a manual switch in the same session', async () => {
    const current = session('en');
    await syncAccountLocale(current);
    expect(readStoredLocale()).toBe('en');

    // 模拟用户切换后账号写入失败：界面已改成 zh，下一次导航的会话刷新不应回退。
    writeStoredLocale('zh');
    await syncAccountLocale(current);

    expect(readStoredLocale()).toBe('zh');
  });

  it('keeps an existing account locale and never overwrites it', async () => {
    const fetchMock = respond204();
    vi.stubGlobal('fetch', fetchMock);
    writeStoredLocale('en');

    await syncAccountLocale(session('zh'));

    expect(readStoredLocale()).toBe('zh');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes a NULL account once from the current language', async () => {
    const fetchMock = respond204();
    vi.stubGlobal('fetch', fetchMock);
    writeStoredLocale('en');
    const current = session(null);

    await syncAccountLocale(current);
    await syncAccountLocale(current);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/locale',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ locale: 'en' }),
      }),
    );
    expect(localStorage.getItem(localeStorageKey)).toBe('en');
  });

  it('leaves the interface language alone when the first write fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('network down');
      }),
    );
    writeStoredLocale('en');

    await expect(syncAccountLocale(session(null))).resolves.toBeUndefined();
    expect(readStoredLocale()).toBe('en');
  });
});

describe('saveAccountLocale', () => {
  it('reports a failed switch instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 500 }))),
    );
    await expect(saveAccountLocale('en')).resolves.toBe(false);
  });
});
