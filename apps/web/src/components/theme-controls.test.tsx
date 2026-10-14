import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setThemePreference } from '../lib/theme';
import { ThemeSegmented } from './theme-controls';

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  setThemePreference('system');
});

describe('ThemeSegmented', () => {
  it('is one Tab stop and arrow keys change the theme', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ThemeSegmented />
        <button type="button">之后</button>
      </>,
    );

    await user.tab();
    expect(screen.getByRole('radio', { name: '跟随系统' })).toHaveFocus();

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: '深色' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: '深色' })).toBeChecked();
    expect(document.documentElement.dataset['theme']).toBe('dark');

    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('radio', { name: '浅色' })).toBeChecked();
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(localStorage.getItem('fs-billing.theme')).toBe('light');

    await user.tab();
    expect(screen.getByRole('button', { name: '之后' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('radio', { name: '浅色' })).toHaveFocus();
  });
});
