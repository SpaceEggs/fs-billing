import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { RatesTab } from './rates-tab';

const tenant: AdminTenantDetailResponse = {
  id: '00000000-0000-4000-8000-00000000a001',
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
  status: 'active',
  health: 'normal',
  settingsConfigured: true,
  balance: '500',
  overdraftLimit: '100',
  availableBalance: '600',
  monthConsumption: '0',
  pendingReceivable: '0',
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: { overdraftLimit: '100', lowBalanceThreshold: '200', emails: [] },
  createdAt: '2026-08-12T02:31:02.000Z',
};

const versionA = '00000000-0000-4000-8000-0000000000aa';
const versionB = '00000000-0000-4000-8000-0000000000bb';

function rates(id: string, rate: string) {
  return {
    currency: 'CNY',
    current: {
      id,
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      entries: [{ prefix: '86', country: '中国', rate }],
    },
    scheduled: [],
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rates tab edit dialog', () => {
  it('a refetch while confirming keeps the base version the edit started from, and the 409 offers a refresh', async () => {
    let current = rates(versionA, '0.045');
    const posts: unknown[] = [];
    const fetchMock = vi.fn((_path: string, init: RequestInit) => {
      if (init.method === 'POST') {
        posts.push(JSON.parse(init.body as string));
        return Promise.resolve(
          json(409, {
            error: {
              code: 'RATE_VERSION_CONFLICT',
              message: '费率表已被修改',
              requestId: 'req-test',
            },
          }),
        );
      }
      return Promise.resolve(json(200, current));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <RatesTab tenant={tenant} />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: '编辑 86 中国' }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑费率' });
    const country = within(dialog).getByLabelText(/国家\/备注/);
    await user.clear(country);
    await user.type(country, '中国大陆');
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：确认' }),
    );
    const confirm = screen.getByRole('dialog', { name: '确认修改费率' });

    // 另一位管理员把费率改成 0.0600（新版本），后台刷新拿到新版本。
    current = rates(versionB, '0.06');
    const gets = fetchMock.mock.calls.length;
    await act(() => client.refetchQueries());
    expect(fetchMock.mock.calls.length).toBeGreaterThan(gets);
    expect(
      screen.getByRole('dialog', { name: '确认修改费率' }),
    ).toHaveTextContent('0.0450');

    await user.click(within(confirm).getByRole('button', { name: '确认修改' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      baseVersionId: versionA,
      entry: { prefix: '86', country: '中国大陆', rate: '0.045' },
      schedule: { kind: 'immediate' },
    });

    const alert = await within(confirm).findByRole('alert');
    expect(alert).toHaveTextContent('费率表已被修改，请刷新后重试');
    await user.click(within(alert).getByRole('button', { name: '刷新' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('0.0600')).toBeInTheDocument();
  });
});
