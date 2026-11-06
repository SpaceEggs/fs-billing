import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../test/i18n';
import { LocaleMenu } from './locale-menu';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LocaleMenu', () => {
  it('switches language, updates html lang, and persists the choice', async () => {
    const user = userEvent.setup();
    await renderWithLocale('zh', <LocaleMenu />);
    expect(document.documentElement.lang).toBe('zh-CN');

    await user.click(screen.getByRole('button', { name: '语言' }));
    expect(screen.getByRole('menuitemradio', { name: '中文' })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    await user.click(screen.getByRole('menuitemradio', { name: 'English' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(localStorage.getItem('fs-billing.locale')).toBe('en');
    expect(
      screen.getByRole('button', { name: 'Language' }),
    ).toBeInTheDocument();
  });

  it('sends the choice to the account when signed in', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    await renderWithLocale('zh', <LocaleMenu signedIn />);

    await user.click(screen.getByRole('button', { name: '语言' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'English' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('/api/auth/locale');
    expect(init.method).toBe('POST');
    const body = init.body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(body as string)).toEqual({ locale: 'en' });
    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
  });

  it('does not send anything from the login page', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    await renderWithLocale('zh', <LocaleMenu />);

    await user.click(screen.getByRole('button', { name: '语言' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'English' }));

    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the new interface language when the account request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('network down');
      }),
    );
    const user = userEvent.setup();
    await renderWithLocale('zh', <LocaleMenu signedIn />);

    await user.click(screen.getByRole('button', { name: '语言' }));
    await user.click(screen.getByRole('menuitemradio', { name: 'English' }));

    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(localStorage.getItem('fs-billing.locale')).toBe('en');
  });

  it('shows the active language and only marks the selected item', async () => {
    const user = userEvent.setup();
    await renderWithLocale('en', <LocaleMenu />);

    await user.click(screen.getByRole('button', { name: 'Language' }));
    const english = screen.getByRole('menuitemradio', { name: 'English' });
    expect(english).toHaveAttribute('aria-checked', 'true');
    expect(english.querySelector('svg')).not.toBeNull();
    expect(
      screen.getByRole('menuitemradio', { name: '中文' }).querySelector('svg'),
    ).toBeNull();
  });
});
