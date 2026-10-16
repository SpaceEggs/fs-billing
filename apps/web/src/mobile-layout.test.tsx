import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordGate, sessionExpiry } from './lib/session';
import { adminApi, page, renderApp } from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

const tenantId = '00000000-0000-4000-8000-00000000a001';
const detailPath = `/api/admin/tenants/${tenantId}`;

const tenant = {
  id: tenantId,
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
  status: 'active',
  health: 'overdraft',
  settingsConfigured: true,
  balance: '-35.2',
  overdraftLimit: '100',
  availableBalance: '64.8',
  monthConsumption: '2486.3',
  pendingReceivable: '500',
};

const detail = {
  ...tenant,
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: {
    overdraftLimit: '100',
    lowBalanceThreshold: '200',
    emails: ['ops@example.com'],
  },
  createdAt: '2026-09-01T02:00:00.000Z',
};

const overview = {
  asOf: '2026-10-15T06:03:27.120Z',
  currency: 'CNY',
  monthSpend: '0',
  monthCallMinutes: '0',
  answeredCalls: 0,
  unansweredCalls: 0,
  daily: [],
  dailyTotal: '0',
};

function openDetail(tab = '') {
  const api = adminApi({
    [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
    [`GET ${detailPath}/overview`]: () => ({ status: 200, body: overview }),
  });
  const app = renderApp(`/admin/tenants/${tenantId}${tab}`, api.handler);
  return { ...api, ...app, user: userEvent.setup() };
}

describe('mobile tenant detail header', () => {
  it('shows the compact balance line with back link and code title', async () => {
    openDetail();
    const summary = await screen.findByRole('region', { name: '余额概要' });
    expect(summary).toHaveTextContent(
      '深圳市某某科技有限公司透支中CNY · 可用 ¥64.80当前余额-¥35.20',
    );
    expect(screen.getByRole('link', { name: '返回租户列表' })).toHaveAttribute(
      'href',
      '/admin/tenants',
    );
  });

  it('the ⋯ sheet opens the status dialog and focus returns to ⋯ afterwards', async () => {
    const { user } = openDetail();
    const more = await screen.findByRole('button', { name: '租户操作' });
    await user.click(more);
    const sheet = await screen.findByRole('dialog', { name: 'ABC001 的操作' });
    expect(within(sheet).getByRole('link', { name: '编辑' })).toHaveAttribute(
      'href',
      `/admin/tenants/${tenantId}/edit`,
    );
    await user.click(within(sheet).getByRole('button', { name: '停用' }));
    const dialog = await screen.findByRole('dialog', {
      name: '停用租户 ABC001？',
    });
    expect(
      screen.queryByRole('dialog', { name: 'ABC001 的操作' }),
    ).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '取消' }));
    await waitFor(() => expect(more).toHaveFocus());
  });

  it('pins 余额操作 below every tab except settings', async () => {
    const { user } = openDetail();
    await screen.findByRole('region', { name: '余额概要' });
    expect(screen.getAllByRole('button', { name: '余额操作' })).toHaveLength(2);
    await user.click(screen.getByRole('link', { name: '设置' }));
    await screen.findByRole('button', { name: '保存修改' });
    expect(screen.getAllByRole('button', { name: '余额操作' })).toHaveLength(1);
  });
});

describe('mobile page headings', () => {
  /** jsdom 不加载 Tailwind：只模拟手机宽度下生效的显示规则（md: 不生效，hidden 与 sr-only 生效）。 */
  function mobileStyles() {
    const style = document.createElement('style');
    style.textContent = `.hidden { display: none; }
      .max-md\\:sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }`;
    document.head.append(style);
    return () => style.remove();
  }

  it.each([
    [
      'tenant detail (title row with actions)',
      `/admin/tenants/${tenantId}`,
      '深圳市某某科技有限公司',
    ],
    ['tenant list (title row with meta)', '/admin/tenants', '租户'],
    ['tenant create (plain title)', '/admin/tenants/new', '新建租户'],
  ])('%s keeps a page h1 for screen readers', async (_name, path, title) => {
    const unstyle = mobileStyles();
    try {
      const api = adminApi({
        [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
        [`GET ${detailPath}/overview`]: () => ({ status: 200, body: overview }),
        'GET /api/admin/tenants': () => ({ status: 200, body: page([tenant]) }),
      });
      renderApp(path, api.handler);
      expect(
        await screen.findByRole('heading', { level: 1, name: title }),
      ).toBeInTheDocument();
      // 电脑版操作按钮在手机上仍不可见、不可聚焦。
      expect(screen.queryByRole('link', { name: '编辑' })).toBeNull();
    } finally {
      unstyle();
    }
  });
});

describe('mobile list top bar and filter sheet', () => {
  it('tenant list puts ＋ in the top bar and filters status and currency from the sheet', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page([tenant]) }),
    });
    const { location } = renderApp('/admin/tenants?search=ABC', handler);
    const user = userEvent.setup();
    expect(
      await screen.findByRole('link', { name: '新建租户' }),
    ).toHaveAttribute('href', '/admin/tenants/new');

    await user.click(screen.getByRole('button', { name: '筛选' }));
    const sheet = await screen.findByRole('dialog', { name: '筛选' });
    expect(
      within(sheet).getByRole('button', { name: '清除筛选' }),
    ).toBeDisabled();
    await user.click(within(sheet).getByRole('button', { name: '透支中' }));
    await user.click(within(sheet).getByRole('button', { name: 'CNY' }));
    await waitFor(() =>
      expect(location()).toBe(
        '/admin/tenants?search=ABC&status=overdraft&currency=CNY',
      ),
    );
    expect(calls.at(-1)?.path).toBe(
      '/api/admin/tenants?page=1&pageSize=25&search=ABC&status=overdraft&currency=CNY&sort=status_currency_balance',
    );
    expect(
      await within(sheet).findByRole('button', { name: '查看 1 个结果' }),
    ).toBeVisible();

    await user.click(within(sheet).getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(location()).toBe('/admin/tenants?search=ABC'));
    await user.click(within(sheet).getByRole('button', { name: /^查看/ }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: '筛选' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '筛选' })).toHaveFocus();
  });

  it('the filter button names how many filters are set', async () => {
    const { handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page([tenant]) }),
    });
    renderApp('/admin/tenants?status=overdraft&currency=CNY', handler);
    expect(
      await screen.findByRole('button', { name: '筛选，已选 2 项' }),
    ).toBeVisible();
  });

  it('receivables keep the status segment visible and move currency into the sheet', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/receivables': () => ({
        status: 200,
        body: {
          items: [],
          totals: { CNY: '0', USD: '0' },
          pagination: { page: 1, pageSize: 25, total: 0 },
        },
      }),
    });
    const { location } = renderApp('/admin/receivables', handler);
    const user = userEvent.setup();
    expect(await screen.findByRole('group', { name: '状态' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '筛选' }));
    const sheet = await screen.findByRole('dialog', { name: '筛选' });
    await user.click(within(sheet).getByRole('button', { name: 'USD' }));
    await waitFor(() =>
      expect(location()).toBe('/admin/receivables?currency=USD'),
    );
    expect(calls.at(-1)?.path).toBe(
      '/api/admin/receivables?page=1&pageSize=25&currency=USD&status=pending',
    );
  });

  it('admin accounts open the create dialog from the top-bar ＋', async () => {
    const { handler } = adminApi({
      'GET /api/admin/admins': () => ({ status: 200, body: page([]) }),
    });
    renderApp('/admin/admins', handler);
    const user = userEvent.setup();
    const plus = await screen.findByRole('button', { name: '新增管理员' });
    await user.click(plus);
    expect(
      await screen.findByRole('dialog', { name: '新增管理员' }),
    ).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(plus).toHaveFocus());
  });
});

describe('mobile forms', () => {
  it('the short threshold label keeps the full accessible name', async () => {
    const { handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page([]) }),
    });
    renderApp('/admin/tenants/new', handler);
    expect(
      await screen.findByRole('textbox', { name: '余额提醒阈值' }),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: '取消新建，返回租户列表' }),
    ).toHaveAttribute('href', '/admin/tenants');
  });

  it('settings 「＋ 添加邮箱」 reveals and focuses the email input', async () => {
    const { user } = openDetail('?tab=settings');
    const add = await screen.findByRole('button', { name: '＋ 添加邮箱' });
    await user.click(add);
    expect(screen.getByLabelText('通知邮箱')).toHaveFocus();
  });
});
