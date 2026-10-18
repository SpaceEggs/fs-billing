import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityBlock } from './lib/session';
import {
  adminApi,
  adminSession,
  apiError,
  page,
  renderApp,
  type ApiHandler,
} from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  identityBlock.clear();
});

const tenantId = '00000000-0000-4000-8000-00000000a001';
const detailPath = `/api/admin/tenants/${tenantId}`;

const tenant = {
  id: tenantId,
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
};

const detail = {
  ...tenant,
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: { overdraftLimit: '100', lowBalanceThreshold: '200', emails: [] },
  createdAt: '2026-08-12T02:31:02.000Z',
};

const ledger = {
  currency: 'CNY',
  balance: '500',
  totalAmount: '88.88',
  ...page([
    {
      id: '00000000-0000-4000-8000-0000000e0001',
      kind: 'gift',
      amount: '88.88',
      balanceAfter: '500',
      note: '春节回馈',
      noteVisibility: 'customer',
      paymentStatus: null,
      actor: { id: '00000000-0000-4000-8000-000000000099', name: '系统' },
      occurredAt: '2026-10-15T06:03:27.120Z',
    },
  ]),
};

const rates = {
  currency: 'CNY',
  current: {
    id: '00000000-0000-4000-8000-0000000000aa',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    entries: [{ prefix: '86', country: '中国', rate: '0.1' }],
  },
  scheduled: [],
};

const admins = page([
  {
    id: adminSession.identity.profileId,
    name: '王敏',
    email: 'wangmin@example.com',
    status: 'active',
    lastLoginAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
]);

/** 首次请求成功；`fail` 之后同一路径按给定错误应答。 */
function failable(body: unknown) {
  let failure: { status: number; body: unknown } | null = null;
  const handler: ApiHandler = () => failure ?? { status: 200, body };
  return {
    handler,
    fail: (status: number, code: string, extra: object = {}) => {
      failure = { status, body: apiError(code, extra) };
    },
  };
}

// 429 不自动重试，测试不用等重试间隔；仍提供“重试”。
const rateLimited = ['RATE_LIMITED', { retryAfterSeconds: 30 }] as const;

describe('a refresh failure keeps cached data visible with a notice', () => {
  it.each([
    {
      name: 'tenant list',
      path: '/admin/tenants',
      route: `GET /api/admin/tenants`,
      body: page([tenant]),
      shown: 'ABC001',
      notice: '租户列表刷新失败，列表可能不是最新',
    },
    {
      name: 'tenant detail',
      path: `/admin/tenants/${tenantId}?tab=ledger`,
      route: `GET ${detailPath}`,
      body: detail,
      shown: '深圳市某某科技有限公司',
      notice: '租户详情刷新失败，余额与状态可能不是最新',
    },
    {
      name: 'ledger',
      path: `/admin/tenants/${tenantId}?tab=ledger`,
      route: `GET ${detailPath}/ledger`,
      body: ledger,
      shown: '春节回馈',
      notice: '余额流水刷新失败，列表可能不是最新',
    },
    {
      name: 'rates',
      path: `/admin/tenants/${tenantId}?tab=rates`,
      route: `GET ${detailPath}/rates`,
      body: rates,
      shown: '中国',
      notice: '费率表刷新失败，显示的可能不是最新',
    },
    {
      name: 'admin accounts',
      path: '/admin/admins',
      route: 'GET /api/admin/admins',
      body: admins,
      shown: 'wangmin@example.com',
      notice: '管理员列表刷新失败，列表可能不是最新',
    },
  ])('$name', async ({ path, route, body, shown, notice }) => {
    const target = failable(body);
    const { handler } = adminApi({
      [`GET /api/admin/tenants`]: () => ({ status: 200, body: page([tenant]) }),
      [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
      [`GET ${detailPath}/ledger`]: () => ({ status: 200, body: ledger }),
      [`GET ${detailPath}/rates`]: () => ({ status: 200, body: rates }),
      'GET /api/admin/admins': () => ({ status: 200, body: admins }),
      [route]: target.handler,
    });
    const { queryClient } = renderApp(path, handler);
    expect((await screen.findAllByText(shown))[0]).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();

    target.fail(429, ...rateLimited);
    await act(() => queryClient.refetchQueries());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(notice);
    expect(screen.getAllByText(shown)[0]).toBeVisible();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});

describe('a blocked identity mid-session', () => {
  it.each(['ACCOUNT_DISABLED', 'IDENTITY_UNAVAILABLE'])(
    '%s from a page request replaces the cached page with the blocked page',
    async (code) => {
      const list = failable(page([tenant]));
      const { handler } = adminApi({ 'GET /api/admin/tenants': list.handler });
      const { queryClient } = renderApp('/admin/tenants', handler);
      expect((await screen.findAllByText('ABC001'))[0]).toBeVisible();

      list.fail(403, code);
      await act(() => queryClient.refetchQueries());
      expect(
        await screen.findByRole('button', { name: '退出登录' }),
      ).toBeVisible();
      expect(screen.queryByText('ABC001')).toBeNull();
      expect(screen.queryByRole('button', { name: '余额操作' })).toBeNull();
    },
  );

  it('a blocked write response also switches to the blocked page', async () => {
    const { handler } = adminApi({
      [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
      [`GET ${detailPath}/ledger`]: () => ({ status: 200, body: ledger }),
      [`POST ${detailPath}/disable`]: () => ({
        status: 403,
        body: apiError('ACCOUNT_DISABLED'),
      }),
    });
    renderApp(`/admin/tenants/${tenantId}?tab=ledger`, handler);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: '停用' }));
    await user.click(await screen.findByRole('button', { name: '停用租户' }));
    await waitFor(() =>
      expect(screen.queryByText('深圳市某某科技有限公司')).toBeNull(),
    );
    expect(screen.getByRole('button', { name: '退出登录' })).toBeVisible();
  });
});
