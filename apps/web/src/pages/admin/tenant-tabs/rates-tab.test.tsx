import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { beijingMinute } from '../../../lib/rates';
import { createQueryClient } from '../../../query-client';
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
      entries: [
        { iso: '', description: '', prefix: '86', country: '中国', rate },
      ],
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

const labelled = [
  {
    prefix: '1',
    iso: '',
    country: '美国/加拿大',
    description: '',
    rate: '0.01',
  },
  { prefix: '44', iso: 'GB', country: '英国', description: '', rate: '0.02' },
  {
    prefix: '447',
    iso: 'GB',
    country: '英国',
    description: '手机',
    rate: '0.045',
  },
];

function stubLabelled(onPost?: (body: unknown) => void) {
  const gets: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string, init: RequestInit) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body as string) as {
          entry: (typeof labelled)[number];
        };
        onPost?.(body);
        return Promise.resolve(
          json(200, {
            auditId: '00000000-0000-4000-8000-00000000b201',
            version: {
              id: versionB,
              effectiveFrom: '2026-10-02T00:00:00.000Z',
              entries: labelled.map((e) =>
                e.prefix === body.entry.prefix ? body.entry : e,
              ),
            },
          }),
        );
      }
      gets.push(path);
      return Promise.resolve(
        json(200, {
          currency: 'CNY',
          current: {
            id: versionA,
            effectiveFrom: '2026-10-01T00:00:00.000Z',
            entries: labelled,
          },
          scheduled: [],
        }),
      );
    }),
  );
  return { gets };
}

function renderTab() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RatesTab tenant={tenant} />
    </QueryClientProvider>,
  );
}

/** jsdom 不加载样式：电脑版单元格 = 没有 md:hidden 的 td。手机版合并标签另行断言。 */
const desktopCells = (row: Element) =>
  [...row.querySelectorAll('td:not(.md\\:hidden)')].map(
    (cell) => cell.textContent,
  );

describe('rates tab columns and search', () => {
  it('shows ISO, 国家, 号码前缀, 说明 and 费率 columns', async () => {
    stubLabelled();
    renderTab();
    await screen.findByRole('button', { name: '编辑 447 英国 · 手机' });
    const table = within(screen.getByRole('region', { name: '费率表' }));
    expect(
      table.getAllByRole('columnheader').map((cell) => cell.textContent),
    ).toEqual(['ISO', '国家', '号码前缀', '说明', '费率（元/分钟）', '操作']);
    const rows = table.getAllByRole('row').slice(1);
    expect(rows.map(desktopCells)).toEqual([
      ['', '美国/加拿大', '1', '', '0.0100元/分钟', '编辑'],
      ['GB', '英国', '44', '', '0.0200元/分钟', '编辑'],
      ['GB', '英国', '447', '手机', '0.0450元/分钟', '编辑'],
    ]);
    expect(
      rows.map((row) => row.querySelector('td.md\\:hidden')?.textContent),
    ).toEqual(['美国/加拿大', '英国', '英国 · 手机']);
    expect(
      screen.getByRole('button', { name: '编辑 44 英国' }),
    ).toBeInTheDocument();
  });

  it('search finds a row by ISO or description', async () => {
    const { gets } = stubLabelled();
    renderTab();
    await screen.findByRole('button', { name: '编辑 44 英国' });
    const user = userEvent.setup();
    const box = screen.getByRole('searchbox', {
      name: '搜索前缀、ISO、国家或说明',
    });
    expect(box).toHaveAttribute('placeholder', '搜索前缀、ISO、国家或说明');
    await user.type(box, 'gb');
    await waitFor(() =>
      expect(gets.some((path) => path.includes('search=gb'))).toBe(true),
    );
    await user.clear(box);
    await user.type(box, '手机');
    await waitFor(() =>
      expect(
        gets.some((path) =>
          path.includes(`search=${encodeURIComponent('手机')}`),
        ),
      ).toBe(true),
    );
  });
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
    const country = within(dialog).getByLabelText(/^国家/);
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
      entry: {
        iso: '',
        description: '',
        prefix: '86',
        country: '中国大陆',
        rate: '0.045',
      },
      schedule: { kind: 'immediate' },
    });

    const alert = await within(confirm).findByRole('alert');
    expect(alert).toHaveTextContent('费率表已被修改，请刷新后重试');
    await user.click(within(alert).getByRole('button', { name: '刷新' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('0.0600')).toBeInTheDocument();
  });

  it('edit dialog edits iso, country, description and rate and warns about customer visibility', async () => {
    const posts: unknown[] = [];
    stubLabelled((body) => posts.push(body));
    renderTab();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: '编辑 447 英国 · 手机' }),
    );
    const dialog = screen.getByRole('dialog', { name: '编辑费率' });
    expect(within(dialog).getByLabelText('前缀')).toHaveAttribute('readonly');
    const description = within(dialog).getByLabelText('说明');
    expect(description).toHaveAccessibleDescription(
      '说明会显示在客户的话单里，请勿填写内部备注',
    );
    const type = async (label: RegExp, value: string) => {
      const input = within(dialog).getByLabelText(label);
      await user.clear(input);
      if (value) await user.type(input, value);
    };
    await type(/^ISO/, 'GBR');
    await type(/^国家/, '');
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：确认' }),
    );
    expect(within(dialog).getByLabelText(/^ISO/)).toBeInvalid();
    expect(
      within(dialog).getByText('ISO 必须是两位字母，或留空'),
    ).toBeVisible();
    expect(within(dialog).getByText('请输入国家')).toBeVisible();

    await type(/^ISO/, ' jm ');
    await type(/^国家/, '牙买加');
    await type(/^说明/, '');
    await type(/^费率/, '0.05');
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：确认' }),
    );
    const confirm = screen.getByRole('dialog', { name: '确认修改费率' });
    expect(confirm).toHaveTextContent('447 英国 · 手机');
    expect(confirm).toHaveTextContent('ISO：GB → JM');
    expect(confirm).toHaveTextContent('国家：英国 → 牙买加');
    expect(confirm).toHaveTextContent('说明：手机 → —');
    await user.click(within(confirm).getByRole('button', { name: '确认修改' }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toMatchObject({
      entry: {
        prefix: '447',
        iso: 'JM',
        country: '牙买加',
        description: '',
        rate: '0.05',
      },
    });
    expect(await screen.findByText(/^447 牙买加 费率已改为/)).toBeVisible();
  });

  it('scheduling an edit disables its opener, so focus returns to the rate table', async () => {
    let current: Record<string, unknown> = rates(versionA, '0.045');
    const effectiveFrom = new Date(Date.now() + 86_400_000);
    effectiveFrom.setUTCSeconds(0, 0);
    const scheduledVersion = {
      id: versionB,
      effectiveFrom: effectiveFrom.toISOString(),
      entries: [
        {
          iso: '',
          description: '',
          prefix: '86',
          country: '中国',
          rate: '0.05',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init: RequestInit) => {
        if (init.method === 'POST') {
          current = { ...current, scheduled: [scheduledVersion] };
          return Promise.resolve(
            json(200, {
              auditId: '00000000-0000-4000-8000-00000000b201',
              version: scheduledVersion,
            }),
          );
        }
        return Promise.resolve(json(200, current));
      }),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <RatesTab tenant={tenant} />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    const opener = await screen.findByRole('button', { name: '编辑 86 中国' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: '编辑费率' });
    const rate = within(dialog).getByLabelText(/费率/);
    await user.clear(rate);
    await user.type(rate, '0.05');
    await user.click(
      within(dialog).getByRole('button', { name: '下一步：确认' }),
    );
    const confirm = screen.getByRole('dialog', { name: '确认修改费率' });
    await user.click(
      within(confirm).getByRole('radio', { name: '指定时间生效' }),
    );
    await user.type(
      within(confirm).getByLabelText('指定生效时间（北京时间）'),
      beijingMinute(effectiveFrom.getTime()),
    );
    await user.click(within(confirm).getByRole('button', { name: '确认修改' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText(/^已排定：86 中国/)).toBeVisible();
    expect(screen.getByRole('button', { name: '编辑 86 中国' })).toBeDisabled();
    expect(screen.getByRole('region', { name: '费率表' })).toHaveFocus();
  });
});

describe('rates tab export', () => {
  it('a scheduled version exports its own CSV (G11)', async () => {
    const scheduledVersion = {
      id: versionB,
      effectiveFrom: '2099-01-01T00:00:00.000Z',
      entries: [
        {
          iso: '',
          description: '',
          prefix: '86',
          country: '中国',
          rate: '0.05',
        },
      ],
    };
    const exports: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string, init: RequestInit) => {
        if (init.method === 'POST' && path.endsWith('/rates/export')) {
          const body = JSON.parse(init.body as string) as { versionId: string };
          exports.push(body);
          const rate = body.versionId === versionB ? '0.0500' : '0.0450';
          return Promise.resolve(
            json(200, {
              auditId: '00000000-0000-4000-8000-00000000b301',
              filename: `ABC001-${body.versionId === versionB ? 'scheduled' : 'current'}.csv`,
              encoding: 'UTF-8',
              contentType: 'text/csv',
              csv: `ISO,Country,Destination Prefix,Description,Rate\n,中国,86,,${rate}\n`,
            }),
          );
        }
        return Promise.resolve(
          json(200, {
            ...rates(versionA, '0.045'),
            scheduled: [scheduledVersion],
          }),
        );
      }),
    );
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        return 'blob:rates';
      },
      revokeObjectURL: () => {},
    });
    onTestFinished(() => void vi.restoreAllMocks());
    const downloads: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <RatesTab tenant={tenant} />
      </QueryClientProvider>,
    );

    const scheduled = await screen.findByRole('region', {
      name: '排定的新版本',
    });
    await userEvent.click(
      within(scheduled).getByRole('button', { name: '导出 CSV' }),
    );
    await waitFor(() => expect(downloads).toEqual(['ABC001-scheduled.csv']));
    expect(exports).toEqual([{ versionId: versionB }]);
    expect(await blobs[0]!.text()).toBe(
      'ISO,Country,Destination Prefix,Description,Rate\n,中国,86,,0.0500\n',
    );
  });
});

describe('rates tab scheduled activation', () => {
  it('refetches when a scheduled version takes effect while the page stays open', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const start = Date.parse('2026-10-16T10:00:00.000Z');
    vi.setSystemTime(start);
    const effectiveFrom = start + 5 * 60_000;
    const scheduledVersion = {
      id: versionB,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      entries: [
        {
          iso: '',
          description: '',
          prefix: '86',
          country: '中国',
          rate: '0.05',
        },
      ],
    };
    // 服务端按当前时间决定哪个版本生效。
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        json(
          200,
          Date.now() < effectiveFrom
            ? { ...rates(versionA, '0.045'), scheduled: [scheduledVersion] }
            : {
                currency: 'CNY',
                current: scheduledVersion,
                scheduled: [],
              },
        ),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <RatesTab tenant={tenant} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole('region', { name: '排定的新版本' }),
    ).toBeVisible();
    expect(screen.getAllByText('0.0450').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '导入 CSV' })).toBeDisabled();

    const before = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 - 5_000));
    expect(fetchMock.mock.calls.length).toBe(before);

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: '排定的新版本' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryAllByText('0.0450')).toEqual([]);
    expect(screen.getByText('0.0500')).toBeVisible();
    expect(screen.getByRole('button', { name: '导入 CSV' })).toBeEnabled();

    // 生效后没有排定版本，不再安排刷新。
    const after = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(fetchMock.mock.calls.length).toBe(after);
  });

  it('keeps retrying the activation refetch after a failed attempt until it succeeds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const start = Date.parse('2026-10-16T10:00:00.000Z');
    vi.setSystemTime(start);
    const effectiveFrom = start + 60_000;
    const scheduledVersion = {
      id: versionB,
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      entries: [
        {
          iso: '',
          description: '',
          prefix: '86',
          country: '中国',
          rate: '0.05',
        },
      ],
    };
    let failing = false;
    const fetchMock = vi.fn(() => {
      if (failing)
        return Promise.resolve(
          json(503, {
            error: {
              code: 'SERVICE_UNAVAILABLE',
              message: '服务暂不可用',
              requestId: 'req-test',
            },
          }),
        );
      return Promise.resolve(
        json(
          200,
          Date.now() < effectiveFrom
            ? { ...rates(versionA, '0.045'), scheduled: [scheduledVersion] }
            : { currency: 'CNY', current: scheduledVersion, scheduled: [] },
        ),
      );
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
    expect(
      await screen.findByRole('region', { name: '排定的新版本' }),
    ).toBeVisible();

    // 到点那次刷新失败：仍显示旧版本，但按 10 秒节奏继续重试，不需要切换焦点或手动刷新。
    failing = true;
    const before = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60_000 + 1_000));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
    expect(screen.getByRole('button', { name: '导入 CSV' })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(fetchMock.mock.calls.length).toBe(before + 1);

    failing = false;
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await waitFor(() =>
      expect(
        screen.queryByRole('region', { name: '排定的新版本' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText('0.0500')).toBeVisible();
    expect(screen.getByRole('button', { name: '导入 CSV' })).toBeEnabled();

    const after = fetchMock.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(fetchMock.mock.calls.length).toBe(after);
  });
});

describe('rates tab scheduled activation after unmount', () => {
  const start = Date.parse('2026-10-16T10:00:00.000Z');
  const effectiveFrom = start + 60_000;
  const scheduledVersion = {
    id: versionB,
    effectiveFrom: new Date(effectiveFrom).toISOString(),
    entries: [
      { iso: '', description: '', prefix: '86', country: '中国', rate: '0.05' },
    ],
  };

  /**
   * 用应用自己的 QueryClient（含失败重试）；gcTime 设为不过期，缓存不挂计时器，
   * 卸载后剩下的计时器只可能来自生效刷新或请求重试。
   */
  function renderWithPendingActivation() {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    vi.setSystemTime(start);
    const consoleErrors = vi.spyOn(console, 'error');
    const consoleWarnings = vi.spyOn(console, 'warn');
    onTestFinished(() => void vi.restoreAllMocks());
    let release: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(() =>
      Date.now() < effectiveFrom
        ? Promise.resolve(
            json(200, {
              ...rates(versionA, '0.045'),
              scheduled: [scheduledVersion],
            }),
          )
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = createQueryClient();
    client.setDefaultOptions({
      queries: { ...client.getDefaultOptions().queries, gcTime: Infinity },
    });
    const view = render(
      <QueryClientProvider client={client}>
        <RatesTab tenant={tenant} />
      </QueryClientProvider>,
    );
    return {
      ...view,
      fetchMock,
      consoleErrors,
      consoleWarnings,
      release: (response: Response) => release!(response),
    };
  }

  it.each([
    ['succeeds', () => json(200, rates(versionB, '0.05'))],
    [
      'fails',
      () =>
        json(503, {
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: '服务暂不可用',
            requestId: 'req-test',
          },
        }),
    ],
  ])(
    'an activation refetch that %s after the tab unmounts updates nothing and leaves no timer or retry',
    async (_outcome, response) => {
      const view = renderWithPendingActivation();
      expect(
        await screen.findByRole('region', { name: '排定的新版本' }),
      ).toBeVisible();

      // 到点刷新已发出、尚未返回时用户离开费率标签页。
      const before = view.fetchMock.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(60_000 + 1_000));
      await waitFor(() =>
        expect(view.fetchMock.mock.calls.length).toBe(before + 1),
      );
      view.unmount();
      expect(vi.getTimerCount()).toBe(0);

      view.release(response());
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(vi.getTimerCount()).toBe(0);
      await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
      expect(view.fetchMock.mock.calls.length).toBe(before + 1);
      expect(view.consoleErrors).not.toHaveBeenCalled();
      expect(view.consoleWarnings).not.toHaveBeenCalled();
    },
  );

  it('unmounting before the activation time cancels the pending refetch', async () => {
    const view = renderWithPendingActivation();
    expect(
      await screen.findByRole('region', { name: '排定的新版本' }),
    ).toBeVisible();
    expect(vi.getTimerCount()).toBe(1);

    const before = view.fetchMock.mock.calls.length;
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await act(() => vi.advanceTimersByTimeAsync(60 * 60_000));
    expect(view.fetchMock.mock.calls.length).toBe(before);
    expect(view.consoleErrors).not.toHaveBeenCalled();
    expect(view.consoleWarnings).not.toHaveBeenCalled();
  });
});
