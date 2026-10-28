import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setThemePreference } from '../lib/theme';
import { ThemeMenu, ThemeSegmented } from './theme-controls';

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

describe('ThemeMenu', () => {
  it('marks the chosen option with a check on the right and lets the trigger reopen it', async () => {
    const user = userEvent.setup();
    render(<ThemeMenu />);

    await user.click(screen.getByRole('button', { name: '主题' }));
    const system = screen.getByRole('menuitemradio', { name: '跟随系统' });
    expect(system).toHaveAttribute('aria-checked', 'true');
    expect(system).toHaveClass('justify-between');
    const check = system.querySelector('svg');
    expect(check).not.toBeNull();
    expect(system.lastElementChild?.contains(check)).toBe(true);
    expect(system.firstChild).toHaveTextContent('跟随系统');
    expect(
      screen.getByRole('menuitemradio', { name: '深色' }).querySelector('svg'),
    ).toBeNull();

    await user.click(screen.getByRole('menuitemradio', { name: '深色' }));
    expect(document.documentElement.dataset['theme']).toBe('dark');
    await user.click(screen.getByRole('button', { name: '主题' }));
    expect(screen.getByRole('menuitemradio', { name: '深色' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
