import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../test/i18n';
import { DateRangeField } from './date-range-field';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('DateRangeField (English)', () => {
  it('shows English dates, month, weekdays and buttons without Chinese', async () => {
    const user = userEvent.setup();
    const { container } = await renderWithLocale(
      'en',
      <DateRangeField
        label="Date range"
        value={{ from: '2026-10-01', to: '2026-10-31' }}
        max="2026-10-31"
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', {
        name: 'Date range: 01 Oct 2026 to 31 Oct 2026',
      }),
    ).toBeVisible();
    expect(screen.getByText('01 Oct 2026 — 31 Oct 2026')).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Date range/ }));
    const dialog = screen.getByRole('dialog', { name: 'Date range' });
    expect(dialog).toHaveTextContent('Oct 2026');
    expect(dialog).toHaveTextContent('Mon');
    expect(dialog).toHaveTextContent('Beijing time (UTC+8)');
    expect(
      screen.getByRole('button', { name: 'Previous month' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'OK' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
