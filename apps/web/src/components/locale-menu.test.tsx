import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithLocale } from '../test/i18n';
import { LocaleMenu } from './locale-menu';

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
