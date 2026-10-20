import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AdminRateChange, AdminRateEntry } from '@fs-billing/shared';
import { RateChangesTable } from './rate-changes-table';

const entry = (over: Partial<AdminRateEntry> = {}): AdminRateEntry => ({
  prefix: '447',
  iso: 'GB',
  country: '英国',
  description: '手机',
  rate: '0.0450',
  ...over,
});

function bodyRows(changes: AdminRateChange[]) {
  render(<RateChangesTable changes={changes} currency="CNY" showHeader />);
  return screen
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    );
}

describe('rate changes table', () => {
  it('shows ISO, prefix, country and description columns', () => {
    render(<RateChangesTable changes={[]} currency="CNY" showHeader />);
    expect(
      screen.getAllByRole('columnheader').map((cell) => cell.textContent),
    ).toEqual([
      '变动',
      'ISO',
      '号码前缀',
      '国家',
      '说明',
      '当前费率（元/分钟）',
      '新费率（元/分钟）',
      '涨跌',
    ]);
  });

  it('modified rows show old → new for iso, country and description', () => {
    const before = entry({ iso: '', country: '英国手机', description: '' });
    const rows = bodyRows([
      { kind: 'modified', before, after: entry() },
      {
        kind: 'modified',
        before: entry({ prefix: '44', description: '本土' }),
        after: entry({ prefix: '44', description: '' }),
      },
    ]);
    expect(rows[0]).toEqual([
      '修改',
      '—→GB',
      '447',
      '英国手机→英国',
      '—→手机',
      '0.0450→',
      '0.0450',
      '',
    ]);
    expect(rows[1]?.slice(1, 5)).toEqual(['GB', '44', '英国', '本土→—']);
  });

  it('unchanged labels and added or deleted rows show plain values', () => {
    const rows = bodyRows([
      {
        kind: 'modified',
        before: entry({ prefix: '44', description: '' }),
        after: entry({ prefix: '44', description: '', rate: '0.05' }),
      },
      { kind: 'added', after: entry({ prefix: '33', iso: '' }) },
      { kind: 'deleted', before: entry({ prefix: '1876', iso: 'JM' }) },
    ]);
    expect(rows.map((row) => row.slice(1, 5))).toEqual([
      ['GB', '44', '英国', ''],
      ['', '33', '英国', '手机'],
      ['JM', '1876', '英国', '手机'],
    ]);
  });

  it('strikes the old value only', () => {
    render(
      <RateChangesTable
        changes={[
          { kind: 'modified', before: entry({ iso: 'JM' }), after: entry() },
        ]}
        currency="CNY"
      />,
    );
    expect(screen.getByText('JM')).toHaveClass('line-through');
    expect(screen.getByText('GB')).not.toHaveClass('line-through');
  });
});
