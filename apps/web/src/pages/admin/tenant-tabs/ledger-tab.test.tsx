import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerTab } from './ledger-tab';

const tenantId = '00000000-0000-4000-8000-00000000a001';

function stubLedger() {
  const gets: URLSearchParams[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      gets.push(new URL(path, 'http://localhost').searchParams);
      return Promise.resolve(
        Response.json({
          currency: 'CNY',
          items: [],
          pagination: { page: 1, pageSize: 25, total: 0 },
        }),
      );
    }),
  );
  return gets;
}

function renderTab() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <LedgerTab tenantId={tenantId} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ledger tab date range', () => {
  it('queries whole Beijing days, inclusive of both ends', async () => {
    const gets = stubLedger();
    renderTab();
    await screen.findByText('暂无余额流水');

    fireEvent.change(screen.getByLabelText('开始日期'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('结束日期'), {
      target: { value: '2026-09-29' },
    });
    await waitFor(() =>
      expect(gets.at(-1)?.get('to')).toBe('2026-09-29T23:59:59.999+08:00'),
    );
    expect(gets.at(-1)?.get('from')).toBe('2026-09-01T00:00:00.000+08:00');
    expect(await screen.findByText('请调整日期范围或类型')).toBeVisible();
  });

  it('flags a start after the end and keeps the range out of the query', async () => {
    const gets = stubLedger();
    renderTab();
    await screen.findByText('暂无余额流水');

    fireEvent.change(screen.getByLabelText('结束日期'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('开始日期'), {
      target: { value: '2026-09-02' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '开始日期不能晚于结束日期',
    );
    expect(
      screen.getByRole('group', { name: '日期范围（北京时间）' }),
    ).toHaveAccessibleDescription('开始日期不能晚于结束日期');
    expect(gets.at(-1)?.has('from')).toBe(false);
    expect(gets.at(-1)?.has('to')).toBe(false);
  });
});
