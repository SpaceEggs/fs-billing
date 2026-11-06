import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../test/i18n';
import { Pagination } from './pagination';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('Pagination (English)', () => {
  it('shows the page range and buttons without Chinese', async () => {
    const { container } = await renderWithLocale(
      'en',
      <Pagination page={2} pageSize={10} rowCount={35} onPage={vi.fn()} />,
    );

    expect(
      screen.getByRole('navigation', { name: 'Pagination' }),
    ).toBeVisible();
    expect(screen.getByText('Page 2 of 4')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Previous' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Next' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
