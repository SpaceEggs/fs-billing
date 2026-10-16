import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDate } from './lib/format';
import { passwordGate, sessionExpiry } from './lib/session';
import {
  adminApi,
  apiError,
  deferred,
  renderApp,
  type ApiHandler,
} from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionExpiry.clear();
  passwordGate.clear();
});

const ids = {
  gzt: '00000000-0000-4000-8000-0000000e0001',
  nyc: '00000000-0000-4000-8000-0000000e0002',
  tenantGzt: '00000000-0000-4000-8000-0000000a0001',
  tenantNyc: '00000000-0000-4000-8000-0000000a0002',
  actor: '00000000-0000-4000-8000-0000000ad002',
  settlement: '00000000-0000-4000-8000-0000000f0001',
  newSettlement: '00000000-0000-4000-8000-0000000f0002',
  audit: '00000000-0000-4000-8000-0000000c0001',
};

const receivable = (overrides: Record<string, unknown>) => ({
  ledgerEntryId: ids.gzt,
  latestSettlementId: null,
  tenant: {
    id: ids.tenantGzt,
    code: 'GZT007',
    name: '广州通达云科技有限公司',
    currency: 'CNY',
  },
  amount: '2000',
  internalNote: '季度结算，9月底前付款',
  createdAt: '2026-08-18T03:02:45.000Z',
  actor: { id: ids.actor, name: '李俊' },
  ageDays: 42,
  overdue: true,
  payment: { status: 'pending' },
  ...overrides,
});

const gzt = receivable({});
const nyc = receivable({
  ledgerEntryId: ids.nyc,
  latestSettlementId: ids.settlement,
  tenant: {
    id: ids.tenantNyc,
    code: 'NYC021',
    name: 'Hudson Contact Center Inc',
    currency: 'USD',
  },
  amount: '1200',
  internalNote: 'Wire transfer pending',
  createdAt: '2026-09-26T00:40:51.000Z',
  ageDays: 30,
  overdue: false,
});

const listing = (
  items: unknown[],
  totals = { CNY: '6300', USD: '1700' },
  total = items.length,
  page = 1,
) => ({ items, totals, pagination: { page, pageSize: 25, total } });

type Reply = { status: number; body?: unknown };

const confirmed = (ledgerEntryId: string) => ({
  status: 200,
  body: {
    auditId: ids.audit,
    settlementId: ids.newSettlement,
    ledgerEntryId,
    receivedOn: formatDate(new Date()),
  },
});

const postedTokens = (calls: { method: string; body: unknown }[]) =>
  calls
    .filter((call) => call.method === 'POST')
    .map(
      (call) =>
        (call.body as { expectedLatestSettlementId: string | null })
          .expectedLatestSettlementId,
    );

function openReceivables(
  list: ApiHandler,
  routes: Record<string, ApiHandler> = {},
  path = '/admin/receivables',
) {
  const api = adminApi({ 'GET /api/admin/receivables': list, ...routes });
  const app = renderApp(path, api.handler);
  return { ...api, ...app, user: userEvent.setup() };
}

const listCalls = (calls: { path: string; method: string }[]) =>
  calls.filter(
    (call) =>
      call.method === 'GET' && call.path.startsWith('/api/admin/receivables'),
  );

describe('receivables list', () => {
  it('renders CNY and USD totals separately and highlights only overdue rows', async () => {
    openReceivables(() => ({ status: 200, body: listing([gzt, nyc]) }));
    const totals = await screen.findByRole('list', { name: '待收款合计' });
    expect(
      within(totals)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['待收款总额 · CNY¥6,300.00', '待收款总额 · USD$1,700.00']);

    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('42 天（超过 30 天）');
    expect(rows[0]?.className).toContain('bg-warn-soft');
    // 30 天不高亮：只看 overdue 字段。
    expect(rows[1]).toHaveTextContent('30 天');
    expect(rows[1]).not.toHaveTextContent('超过 30 天');
    expect(rows[1]?.className).not.toContain('bg-warn-soft');
  });

  it('currency filter queries the server and hides the other currency total', async () => {
    const { calls, user, location } = openReceivables((path) =>
      path.includes('currency=USD')
        ? { status: 200, body: listing([nyc], { CNY: '0', USD: '1700' }) }
        : { status: 200, body: listing([gzt, nyc]) },
    );
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'USD' }));
    await waitFor(() =>
      expect(location()).toBe('/admin/receivables?currency=USD'),
    );
    const totals = screen.getByRole('list', { name: '待收款合计' });
    await waitFor(() =>
      expect(within(totals).getAllByRole('listitem')).toHaveLength(1),
    );
    expect(totals).toHaveTextContent('待收款总额 · USD$1,700.00');
    expect(totals).not.toHaveTextContent('CNY');
    expect(screen.getByRole('button', { name: 'USD' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const last = listCalls(calls).at(-1)?.path ?? '';
    const query = new URL(last, 'http://x').searchParams;
    expect(Object.fromEntries(query)).toEqual({
      currency: 'USD',
      status: 'pending',
      page: '1',
      pageSize: '25',
    });
  });

  it('hides the previous filter totals while the newly selected filter loads', async () => {
    const all = deferred<Reply>();
    const { user } = openReceivables(
      (path) =>
        path.includes('currency=CNY')
          ? { status: 200, body: listing([gzt], { CNY: '6300', USD: '0' }) }
          : all.promise,
      {},
      '/admin/receivables?currency=CNY',
    );
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: '全部币种' }));
    const totals = screen.getByRole('list', { name: '待收款合计' });
    await waitFor(() =>
      expect(within(totals).getAllByRole('listitem')).toHaveLength(2),
    );
    // 上一次（CNY 筛选）响应里的 USD "0" 只是占位，不能显示成 USD 合计。
    expect(totals).toHaveAttribute('aria-busy', 'true');
    expect(totals).not.toHaveTextContent('$');
    expect(totals).not.toHaveTextContent('¥');
    expect(
      within(totals)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['待收款总额 · CNY加载中', '待收款总额 · USD加载中']);

    all.resolve({ status: 200, body: listing([gzt, nyc]) });
    await waitFor(() =>
      expect(
        within(totals)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['待收款总额 · CNY¥6,300.00', '待收款总额 · USD$1,700.00']),
    );
    expect(totals).toHaveAttribute('aria-busy', 'false');
  });

  it('search resets to the first page and an empty filtered result offers clearing', async () => {
    const { user, location } = openReceivables(
      (path) =>
        path.includes('search=')
          ? { status: 200, body: listing([], { CNY: '0', USD: '0' }) }
          : { status: 200, body: listing([gzt], undefined, 30) },
      {},
      '/admin/receivables?page=2',
    );
    await screen.findByRole('table');
    await user.type(screen.getByRole('searchbox', { name: '搜索租户' }), 'zzz');
    await waitFor(() =>
      expect(location()).toBe('/admin/receivables?search=zzz'),
    );
    expect(await screen.findByText('没有符合条件的待收款')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(location()).toBe('/admin/receivables'));
  });

  it('shows the all-received empty state without filters', async () => {
    openReceivables(() => ({
      status: 200,
      body: listing([], { CNY: '0', USD: '0' }),
    }));
    expect(await screen.findByText('所有赊账均已收款')).toBeVisible();
    expect(screen.getByText('新的赊账充值会出现在这里')).toBeVisible();
  });

  it.each([
    [500, 'INTERNAL_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])(
    'a %i %s shows the generic unavailable error with retry',
    async (status, code) => {
      let attempts = 0;
      openReceivables(() => {
        attempts += 1;
        return attempts <= 3
          ? { status, body: apiError(code) }
          : { status: 200, body: listing([gzt]) };
      });
      const alert = await screen.findByRole('alert', undefined, {
        timeout: 5000,
      });
      expect(alert).toHaveTextContent(
        '待收款加载失败服务暂时不可用，请稍后重试',
      );
      await userEvent.click(
        within(alert).getByRole('button', { name: '重试' }),
      );
      expect(await screen.findByRole('table')).toBeVisible();
    },
    10_000,
  );
});

describe('confirm payment', () => {
  const today = formatDate(new Date());

  it('sends the listed settlement token with the chosen date and note, no amount', async () => {
    const { calls, user } = openReceivables(
      () => ({ status: 200, body: listing([gzt, nyc]) }),
      {
        [`POST /api/admin/receivables/${ids.nyc}/confirm-payment`]: () => ({
          status: 200,
          body: {
            auditId: ids.audit,
            settlementId: ids.newSettlement,
            ledgerEntryId: ids.nyc,
            receivedOn: today,
          },
        }),
      },
    );
    const table = await screen.findByRole('table');
    await user.click(
      within(table).getByRole('button', { name: '确认收款 NYC021 $1,200.00' }),
    );
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    expect(dialog).toHaveTextContent(
      '确认后该笔状态变为「已收款」，客户余额不变；记入操作日志。',
    );
    expect(within(dialog).getByLabelText(/实际收款日期/)).toHaveValue(today);
    expect(within(dialog).getByLabelText(/实际收款日期/)).toHaveAttribute(
      'min',
      '2026-09-26',
    );
    await user.type(within(dialog).getByLabelText(/收款备注/), '电汇到账');
    await user.click(
      within(dialog).getByRole('button', { name: '确认收款 $1,200.00' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'NYC021 $1,200.00 已确认收款，状态变为「已收款」',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.body).toEqual({
      expectedLatestSettlementId: ids.settlement,
      receivedOn: today,
      note: '电汇到账',
    });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
  });

  it('blocks a date before the credit day without posting', async () => {
    const { calls, user } = openReceivables(() => ({
      status: 200,
      body: listing([gzt]),
    }));
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /确认收款/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    const date = within(dialog).getByLabelText(/实际收款日期/);
    await user.clear(date);
    await user.type(date, '2026-08-17');
    await user.click(
      within(dialog).getByRole('button', { name: /确认收款 ¥/ }),
    );
    expect(
      within(dialog).getByText('收款日期不能早于赊账日期 2026-08-18'),
    ).toBeVisible();
    expect(date).toHaveAttribute('aria-invalid', 'true');
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it.each(['ALREADY_RECEIVED', 'SETTLEMENT_CONFLICT', 'RECEIVABLE_VOIDED'])(
    '409 %s refreshes the list, removes submit and never retries',
    async (code) => {
      const { calls, user } = openReceivables(
        () => ({ status: 200, body: listing([gzt]) }),
        {
          [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => ({
            status: 409,
            body: apiError(code),
          }),
        },
      );
      const table = await screen.findByRole('table');
      await user.click(within(table).getByRole('button', { name: /确认收款/ }));
      const dialog = screen.getByRole('dialog', { name: '确认收款' });
      await user.click(
        within(dialog).getByRole('button', { name: '确认收款 ¥2,000.00' }),
      );
      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent('未确认收款');
      expect(alert).toHaveTextContent('列表已刷新');
      expect(
        within(dialog).queryByRole('button', { name: /确认收款 ¥/ }),
      ).toBeNull();
      await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
      expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
      await user.click(within(dialog).getByRole('button', { name: '关闭' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('reopening after a settlement conflict submits the refreshed token', async () => {
    let refreshed = false;
    const { calls, user } = openReceivables(
      () => ({
        status: 200,
        body: listing([
          refreshed ? { ...gzt, latestSettlementId: ids.settlement } : gzt,
        ]),
      }),
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: (
          _path,
          init,
        ) => {
          const body = JSON.parse(init.body as string) as {
            expectedLatestSettlementId: string | null;
          };
          if (body.expectedLatestSettlementId === null) {
            refreshed = true;
            return { status: 409, body: apiError('SETTLEMENT_CONFLICT') };
          }
          return {
            status: 200,
            body: {
              auditId: ids.audit,
              settlementId: ids.newSettlement,
              ledgerEntryId: ids.gzt,
              receivedOn: today,
            },
          };
        },
      },
    );
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /确认收款/ }));
    let dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: /确认收款 ¥/ }),
    );
    await within(dialog).findByRole('alert');
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    await user.click(within(table).getByRole('button', { name: /确认收款/ }));
    dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: /确认收款 ¥/ }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'GZT007 ¥2,000.00 已确认收款',
    );
    const posts = calls.filter((call) => call.method === 'POST');
    expect(
      posts.map(
        (call) =>
          (call.body as { expectedLatestSettlementId: string | null })
            .expectedLatestSettlementId,
      ),
    ).toEqual([null, ids.settlement]);
  });
  it('moves to the last valid page after confirming the only item on a later page', async () => {
    let paid = false;
    const others = Array.from({ length: 25 }, (_, index) =>
      receivable({
        ledgerEntryId: `00000000-0000-4000-8000-0000000e1${String(index).padStart(3, '0')}`,
        tenant: { ...gzt.tenant, code: `OTH${String(index).padStart(3, '0')}` },
      }),
    );
    const { calls, user, location } = openReceivables(
      (path) => {
        const page = new URL(path, 'http://x').searchParams.get('page');
        if (page === '2')
          return {
            status: 200,
            body: paid
              ? listing([], undefined, 25, 2)
              : listing([gzt], undefined, 26, 2),
          };
        return {
          status: 200,
          body: listing(others, undefined, paid ? 25 : 26),
        };
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => {
          paid = true;
          return confirmed(ids.gzt);
        },
      },
      '/admin/receivables?page=2',
    );
    const table = await screen.findByRole('table');
    expect(screen.getByRole('navigation', { name: '分页' })).toHaveTextContent(
      '第 2 / 2 页',
    );
    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: /确认收款 ¥/ }),
    );
    await waitFor(() => expect(location()).toBe('/admin/receivables'));
    expect(
      await within(screen.getByRole('table')).findByText(/OTH000/),
    ).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: /确认收款 OTH/ }),
    ).toHaveLength(50);
    expect(screen.queryByText('所有赊账均已收款')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'GZT007 ¥2,000.00 已确认收款',
    );
    expect(postedTokens(calls)).toEqual([null]);
  });

  it('focuses the success notice after the confirmed row disappears', async () => {
    let paid = false;
    const { user } = openReceivables(
      () => ({ status: 200, body: listing(paid ? [nyc] : [gzt, nyc]) }),
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => {
          paid = true;
          return confirmed(ids.gzt);
        },
      },
    );
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: /确认收款 ¥/ }),
    );
    const notice = await screen.findByRole('status');
    await waitFor(() =>
      expect(
        within(table).queryByRole('button', { name: /GZT007/ }),
      ).toBeNull(),
    );
    await waitFor(() => expect(notice).toHaveFocus());
  });

  it('cancelling still returns focus to the row that opened the dialog', async () => {
    const { user } = openReceivables(() => ({
      status: 200,
      body: listing([gzt]),
    }));
    const table = await screen.findByRole('table');
    const opener = within(table).getByRole('button', { name: /GZT007/ });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it.each([
    [
      'the row now has a different settlement token',
      () => listing([{ ...gzt, latestSettlementId: ids.settlement }]),
      '请关闭后从列表重新打开再确认',
    ],
    [
      'the row is no longer pending',
      () => listing([nyc]),
      '刷新后的列表中已没有这笔待收款',
    ],
  ])(
    'an open dialog keeps its token and refuses to submit once a refetch shows %s',
    async (_case, refreshed, warning) => {
      const refetch = deferred<Reply>();
      let listed = 0;
      const { calls, user, queryClient } = openReceivables(
        () => {
          listed += 1;
          return listed === 1
            ? { status: 200, body: listing([gzt, nyc]) }
            : refetch.promise;
        },
        {
          [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () =>
            confirmed(ids.gzt),
        },
      );
      const table = await screen.findByRole('table');
      await user.click(within(table).getByRole('button', { name: /GZT007/ }));
      const dialog = screen.getByRole('dialog', { name: '确认收款' });
      const submit = within(dialog).getByRole('button', {
        name: '确认收款 ¥2,000.00',
      });

      void queryClient.invalidateQueries();
      await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
      // 刷新尚未返回：仍可提交打开时的令牌。
      expect(submit).toBeEnabled();

      refetch.resolve({ status: 200, body: refreshed() });
      const alert = await within(dialog).findByRole('alert');
      expect(alert).toHaveTextContent('该笔状态已变化，不能在此确认');
      expect(alert).toHaveTextContent(warning);
      expect(submit).toBeDisabled();
      await user.click(submit);
      expect(postedTokens(calls)).toEqual([]);
      await user.click(within(dialog).getByRole('button', { name: '关闭' }));
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );

  it('reopening after a refetch adopts the refreshed token', async () => {
    let listed = 0;
    const { calls, user, queryClient } = openReceivables(
      () => {
        listed += 1;
        return {
          status: 200,
          body: listing([
            listed === 1 ? gzt : { ...gzt, latestSettlementId: ids.settlement },
          ]),
        };
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () =>
          confirmed(ids.gzt),
      },
    );
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    let dialog = screen.getByRole('dialog', { name: '确认收款' });
    await queryClient.invalidateQueries();
    await within(dialog).findByText(/请关闭后从列表重新打开再确认/);
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: '确认收款 ¥2,000.00' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'GZT007 ¥2,000.00 已确认收款',
    );
    expect(postedTokens(calls)).toEqual([ids.settlement]);
  });

  it('a network failure keeps confirm disabled until the list refresh lands', async () => {
    const refetch = deferred<Reply>();
    let listed = 0;
    let posts = 0;
    const { calls, user } = openReceivables(
      () => {
        listed += 1;
        return listed === 1
          ? { status: 200, body: listing([gzt]) }
          : refetch.promise;
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => {
          posts += 1;
          if (posts === 1) throw new TypeError('network down');
          return confirmed(ids.gzt);
        },
      },
    );
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    const submit = within(dialog).getByRole('button', {
      name: '确认收款 ¥2,000.00',
    });
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '网络中断',
    );
    expect(dialog).toHaveTextContent('正在刷新列表…');
    expect(dialog).not.toHaveTextContent('列表已刷新');
    expect(submit).toBeDisabled();

    refetch.resolve({ status: 200, body: listing([gzt]) });
    expect(await within(dialog).findByText('列表已刷新。')).toBeVisible();
    // 刷新后令牌未变：可用原令牌手动再试。
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'GZT007 ¥2,000.00 已确认收款',
    );
    expect(postedTokens(calls)).toEqual([null, null]);
  });

  it('data cached by an earlier visit does not count as refreshed after returning to the page', async () => {
    const refetch = deferred<Reply>();
    let listed = 0;
    const { calls, queryClient, router, user } = openReceivables(
      () => {
        listed += 1;
        return listed <= 2
          ? { status: 200, body: listing([gzt]) }
          : refetch.promise;
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => {
          throw new TypeError('network down');
        },
      },
    );
    await screen.findByRole('table');
    // 缓存里的响应序号领先于下次进入页面时的序号。
    await queryClient.refetchQueries({
      queryKey: ['api', 'adminReceivables'],
    });
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    await router.navigate({ to: '/admin/change-password' });
    await waitFor(() => expect(screen.queryByRole('table')).toBeNull());
    await router.navigate({ to: '/admin/receivables' });
    const table = await screen.findByRole('table');
    await waitFor(() => expect(listCalls(calls)).toHaveLength(3));

    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    const submit = within(dialog).getByRole('button', {
      name: '确认收款 ¥2,000.00',
    });
    await user.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '网络中断',
    );
    expect(dialog).toHaveTextContent('正在刷新列表…');
    expect(dialog).not.toHaveTextContent('列表已刷新');
    expect(submit).toBeDisabled();

    refetch.resolve({ status: 200, body: listing([gzt]) });
    expect(await within(dialog).findByText('列表已刷新。')).toBeVisible();
    expect(submit).toBeEnabled();
  });

  it('data cached in the same millisecond as the failure does not count as refreshed', async () => {
    // 固定时钟：列表首次返回、确认失败、发起刷新都在同一毫秒。
    vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const refetch = deferred<Reply>();
    let listed = 0;
    const { calls, user } = openReceivables(
      () => {
        listed += 1;
        if (listed === 1) return { status: 200, body: listing([gzt]) };
        if (listed === 2) return refetch.promise;
        return { status: 503, body: apiError('SERVICE_UNAVAILABLE') };
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => {
          throw new TypeError('network down');
        },
      },
    );
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    const submit = within(dialog).getByRole('button', {
      name: '确认收款 ¥2,000.00',
    });
    await user.click(submit);
    await within(dialog).findByRole('alert');
    await waitFor(() => expect(listCalls(calls)).toHaveLength(2));
    expect(dialog).toHaveTextContent('正在刷新列表…');
    expect(dialog).not.toHaveTextContent('列表已刷新');
    expect(submit).toBeDisabled();

    refetch.resolve({ status: 503, body: apiError('SERVICE_UNAVAILABLE') });
    expect(
      await within(dialog).findByText(
        '列表刷新失败，页面显示的可能不是最新状态。',
        undefined,
        { timeout: 8000 },
      ),
    ).toBeVisible();
    expect(dialog).not.toHaveTextContent('列表已刷新');
    expect(submit).toBeDisabled();
    expect(postedTokens(calls)).toEqual([null]);
  }, 15_000);

  it('closing a conflict while the refresh is pending focuses the list, not the disabled row', async () => {
    const refetch = deferred<Reply>();
    let listed = 0;
    const { user } = openReceivables(
      () => {
        listed += 1;
        return listed === 1
          ? { status: 200, body: listing([gzt]) }
          : refetch.promise;
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => ({
          status: 409,
          body: apiError('SETTLEMENT_CONFLICT'),
        }),
      },
    );
    const table = await screen.findByRole('table');
    const opener = within(table).getByRole('button', { name: /GZT007/ });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: '确认收款 ¥2,000.00' }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '正在刷新列表…',
    );
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));

    const list = screen.getByRole('region', { name: '待收款列表' });
    await waitFor(() => expect(list).toHaveFocus());
    expect(opener).toBeDisabled();
    expect(list).toHaveTextContent(
      '正在刷新列表，刷新完成前不能确认 GZT007 ¥2,000.00。',
    );

    refetch.resolve({
      status: 200,
      body: listing([{ ...gzt, latestSettlementId: ids.settlement }]),
    });
    await waitFor(() => expect(opener).toBeEnabled());
    expect(list).not.toHaveTextContent('正在刷新列表');
  });

  it('a failed refresh after a conflict is reported with retry and keeps the row disabled', async () => {
    let listed = 0;
    let recovered = false;
    const { user } = openReceivables(
      () => {
        listed += 1;
        if (listed === 1) return { status: 200, body: listing([gzt]) };
        return recovered
          ? {
              status: 200,
              body: listing([{ ...gzt, latestSettlementId: ids.settlement }]),
            }
          : { status: 503, body: apiError('SERVICE_UNAVAILABLE') };
      },
      {
        [`POST /api/admin/receivables/${ids.gzt}/confirm-payment`]: () => ({
          status: 409,
          body: apiError('SETTLEMENT_CONFLICT'),
        }),
      },
    );
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: /GZT007/ }));
    const dialog = screen.getByRole('dialog', { name: '确认收款' });
    await user.click(
      within(dialog).getByRole('button', { name: '确认收款 ¥2,000.00' }),
    );
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('未确认收款');
    expect(alert).toHaveTextContent('正在刷新列表…');
    expect(
      await within(alert).findByText(
        '列表刷新失败，页面显示的可能不是最新状态。',
        undefined,
        { timeout: 8000 },
      ),
    ).toBeVisible();
    expect(alert).not.toHaveTextContent('列表已刷新');
    await user.click(within(dialog).getByRole('button', { name: '关闭' }));
    // 打开者已禁用：焦点落到列表区域，紧接着就是刷新失败提示与重试。
    const list = screen.getByRole('region', { name: '待收款列表' });
    await waitFor(() => expect(list).toHaveFocus());

    const notice = screen.getByRole('alert');
    expect(notice).toHaveTextContent('待收款刷新失败，列表可能不是最新');
    const row = within(table).getByRole('button', { name: /GZT007/ });
    expect(row).toBeDisabled();

    recovered = true;
    await user.click(within(notice).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(row).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
  }, 15_000);
});
