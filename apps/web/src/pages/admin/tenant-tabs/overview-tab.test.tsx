import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewTab } from './overview-tab';

const tenantId = '00000000-0000-4000-8000-00000000a001';

/** 2026-09-16 … 2026-10-15，截至北京时间 2026-10-15 14:03。 */
function days(spend: (index: number) => string) {
  return Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 8, 16 + index)).toISOString().slice(0, 10),
    spend: spend(index),
  }));
}

const overview = {
  asOf: '2026-10-15T06:03:27.120Z',
  currency: 'CNY',
  monthSpend: '2486.3',
  monthCallMinutes: '49726',
  answeredCalls: 12804,
  unansweredCalls: 713,
  // 只有 3 天有消费，其余为服务端补零的日期。
  daily: days((index) =>
    index === 3 ? '120' : index === 10 ? '30.5' : index === 29 ? '88.64' : '0',
  ),
  dailyTotal: '239.14',
};

function renderTab(reply: () => { status: number; body: unknown }) {
  const fetchMock = vi.fn(() => {
    const { status, body } = reply();
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OverviewTab tenantId={tenantId} />
    </QueryClientProvider>,
  );
  return fetchMock;
}

const bars = () =>
  within(screen.getByRole('list', { name: '最近 30 天每日消费' })).getAllByRole(
    'listitem',
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('tenant overview tab', () => {
  it('renders month, call and today cards from the overview', async () => {
    const fetchMock = renderTab(() => ({ status: 200, body: overview }));
    expect(screen.getByLabelText('概况加载中')).toBeInTheDocument();

    const month = await screen.findByRole('region', { name: '本月消费' });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/admin/tenants/${tenantId}/overview`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(month).toHaveTextContent('¥2,486.30');
    expect(month).toHaveTextContent('2026-10-01 至今 · 截至 14:03');
    const calls = screen.getByRole('region', { name: '本月通话' });
    expect(calls).toHaveTextContent('49,726分钟');
    expect(calls).toHaveTextContent('13,517 通 · 含未接通 713');
    const today = screen.getByRole('region', { name: '今日消费' });
    expect(today).toHaveTextContent('¥88.64');
    expect(today).toHaveTextContent('截至 14:03');
    expect(today).toHaveClass('hidden', 'md:flex');
  });

  it('draws all 30 days with zero days flat, highlights today and shows the server total', async () => {
    renderTab(() => ({ status: 200, body: overview }));
    const chart = await screen.findByRole('region', {
      name: '最近 30 天每日消费',
    });
    expect(chart).toHaveTextContent('2026-09-16 至 2026-10-15');
    expect(within(chart).getByLabelText('合计 ¥239.14')).toBeInTheDocument();

    const items = bars();
    expect(items).toHaveLength(30);
    // 峰值 120 落在纵轴 ¥40 × 3 的顶格。
    expect(items[3]).toHaveStyle({ height: '100.0%' });
    expect(items[10]).toHaveStyle({ height: '25.4%' });
    expect(items[0]).toHaveStyle({ height: '0%' });
    expect(items[0]).toHaveAccessibleName('2026-09-16 ¥0.00');
    expect(items[28]).toHaveStyle({ height: '0%' });

    const current = items.filter(
      (item) => item.getAttribute('aria-current') === 'date',
    );
    expect(current).toEqual([items[29]]);
    expect(items[29]).toHaveAccessibleName('2026-10-15（今日） ¥88.64');
    expect(items[29]).toHaveClass('bg-primary');
    expect(items[28]).toHaveClass('bg-brand-border');
    expect(screen.queryByText('最近 30 天没有消费')).not.toBeInTheDocument();
  });

  it('a month with no spend still lists 30 zero days and says so', async () => {
    renderTab(() => ({
      status: 200,
      body: {
        ...overview,
        monthSpend: '0',
        monthCallMinutes: '0',
        answeredCalls: 0,
        unansweredCalls: 2,
        daily: days(() => '0'),
        dailyTotal: '0',
      },
    }));
    expect(await screen.findByText('最近 30 天没有消费')).toBeVisible();
    expect(bars()).toHaveLength(30);
    expect(screen.getByLabelText('合计 ¥0.00')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '本月通话' })).toHaveTextContent(
      '2 通 · 含未接通 2',
    );
  });

  it('a 503 shows the unavailable message with a retry that refetches', async () => {
    let status = 503;
    const fetchMock = renderTab(() =>
      status === 503
        ? {
            status,
            body: {
              error: {
                code: 'SERVICE_UNAVAILABLE',
                message: '服务不可用',
                requestId: 'req-test',
              },
            },
          }
        : { status, body: overview },
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('概况加载失败');
    expect(alert).toHaveTextContent('服务暂时不可用，请稍后重试');

    status = 200;
    await userEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(
      await screen.findByRole('region', { name: '本月消费' }),
    ).toHaveTextContent('¥2,486.30');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a response in the old overview shape is an error, not a half-filled page', async () => {
    renderTab(() => ({
      status: 200,
      body: {
        currency: 'CNY',
        monthConsumption: '1',
        monthCallMinutes: '1',
        dailyConsumption: [],
      },
    }));
    expect(await screen.findByRole('alert')).toHaveTextContent('概况加载失败');
  });
});
