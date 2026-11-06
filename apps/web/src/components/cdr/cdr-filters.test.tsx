import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { CdrFilterBar } from './cdr-filters';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('CdrFilterBar (English)', () => {
  it('shows English filter labels without Chinese', async () => {
    const { container } = await renderWithLocale(
      'en',
      <CdrFilterBar
        range={{ from: '2026-10-01', to: '2026-10-17' }}
        maxDate="2026-10-17"
        filters={{}}
        countries={['United Kingdom']}
        resultLabel="Show results"
        onRange={vi.fn()}
        onFilters={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('searchbox', { name: 'Callee number' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Date range \(Beijing time\)/ }),
    ).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Call status' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Answered' })).toBeVisible();
    expect(screen.getByRole('tablist', { name: 'Direction' })).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Inbound' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
