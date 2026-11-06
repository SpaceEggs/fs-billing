import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AdminRateChange, AdminRateEntry } from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import { RateChangesTable } from './rate-changes-table';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const entry = (over: Partial<AdminRateEntry> = {}): AdminRateEntry => ({
  prefix: '447',
  iso: 'GB',
  country: 'United Kingdom',
  description: 'Mobile',
  rate: '0.0450',
  ...over,
});

const changes: AdminRateChange[] = [
  {
    kind: 'modified',
    before: entry({ prefix: '44', country: 'United Kingdom landline' }),
    after: entry({ prefix: '44', country: 'United Kingdom', rate: '0.0500' }),
  },
  { kind: 'added', after: entry({ prefix: '33', country: 'France' }) },
  { kind: 'deleted', before: entry({ prefix: '1876', country: 'Jamaica' }) },
];

describe('rate changes table (English)', () => {
  it('renders English headers, tags and rate units without Chinese', async () => {
    const { container } = await renderWithLocale(
      'en',
      <RateChangesTable changes={changes} currency="CNY" showHeader />,
    );

    expect(
      screen.getAllByRole('columnheader').map((cell) => cell.textContent),
    ).toEqual([
      'Change',
      'ISO',
      'Prefix',
      'Country',
      'Description',
      'Current rate (¥/min)',
      'New rate (¥/min)',
      'Change',
    ]);
    const rows = screen
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      );
    expect(rows[0]?.[0]).toBe('Modified');
    expect(rows[1]?.[0]).toBe('Added');
    expect(rows[2]?.[0]).toBe('Deleted');
    expect(container).not.toHaveTextContent(HAN);
  });
});
