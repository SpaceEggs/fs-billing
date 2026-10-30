import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiry } from './lib/session';
import { adminSession, apiError, customerSession, renderApp } from './test/app';
import { homeResponse } from './test/portal-home';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
});

const balance = homeResponse;

async function signIn(email: string, password: string) {
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('登录邮箱'), email);
  await user.type(screen.getByLabelText('密码'), password);
  await user.click(screen.getByRole('button', { name: '登录' }));
  return user;
}

describe('session expiry', () => {
  it('a 401 reauthenticate on the page prompts re-login and returns to the original page', async () => {
    let contextCalls = 0;
    const { location } = renderApp('/?tab=ledger', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/home') {
        contextCalls += 1;
        return contextCalls > 1
          ? { status: 200, body: balance }
          : {
              status: 401,
              body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
            };
      }
      if (path === '/api/auth/login')
        return { status: 200, body: customerSession };
      throw new Error(`unexpected ${path}`);
    });

    const dialog = await screen.findByRole('dialog', {
      name: '登录已过期，请重新登录',
    });
    await userEvent.click(
      within(dialog).getByRole('button', { name: '重新登录' }),
    );
    await waitFor(() => expect(location()).toBe('/login?reason=expired'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '登录已过期，请重新登录登录后将返回之前的页面',
    );

    await signIn('abc001@example.com', 'correct-password');
    await waitFor(() => expect(location()).toBe('/?tab=ledger'));
    expect(
      await screen.findByRole('region', { name: '当前余额' }),
    ).toHaveTextContent('-¥35.20');
  });

  it('an unauthenticated visit redirects to the zone login without the expired banner', async () => {
    const { location } = renderApp('/admin?view=1', (path) => {
      if (path === '/api/auth/session')
        return {
          status: 401,
          body: apiError('UNAUTHENTICATED', { action: 'reauthenticate' }),
        };
      throw new Error(`unexpected ${path}`);
    });
    await waitFor(() => expect(location()).toBe('/admin/login'));
    expect(screen.queryByRole('status')).toBeNull();
    expect(sessionStorage.getItem('fs-billing.return-to')).toBe(
      '/admin?view=1',
    );
  });

  it('a 403 does not ask the user to sign in again', async () => {
    renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: customerSession };
      return { status: 403, body: apiError('FORBIDDEN') };
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      '没有权限查看当前账号无权查看此内容，如有疑问请联系管理员',
    );
    expect(within(alert).queryByRole('button', { name: '重试' })).toBeNull();
    expect(screen.queryByRole('region', { name: '当前余额' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a disabled profile sees the disabled page with logout only', async () => {
    const { location } = renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return { status: 403, body: apiError('ACCOUNT_DISABLED') };
      if (path === '/api/auth/logout') return { status: 204 };
      throw new Error(`unexpected ${path}`);
    });
    expect(
      await screen.findByRole('heading', { name: '该账号已停用' }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(location()).toBe('/login'));
  });
});

describe('unavailable sessionStorage', () => {
  it('still redirects on expiry and returns to the original page after login', async () => {
    const storage = vi
      .spyOn(window, 'sessionStorage', 'get')
      .mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
    try {
      let sessionCalls = 0;
      const { location } = renderApp('/?tab=ledger', (path) => {
        if (path === '/api/auth/session') {
          sessionCalls += 1;
          return sessionCalls === 1
            ? {
                status: 401,
                body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
              }
            : { status: 200, body: customerSession };
        }
        if (path === '/api/auth/login')
          return { status: 200, body: customerSession };
        if (path === '/api/portal/home') return { status: 200, body: balance };
        throw new Error(`unexpected ${path}`);
      });
      await waitFor(() => expect(location()).toBe('/login?reason=expired'));
      await signIn('abc001@example.com', 'correct-password');
      await waitFor(() => expect(location()).toBe('/?tab=ledger'));
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      storage.mockRestore();
    }
  });

  it('a storage read failure after login still lands on the home page', async () => {
    const { location } = renderApp('/login', (path) => {
      if (path === '/api/auth/login' || path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/home') return { status: 200, body: balance };
      throw new Error(`unexpected ${path}`);
    });
    const getItem = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
    try {
      await signIn('abc001@example.com', 'correct-password');
      await waitFor(() => expect(location()).toBe('/'));
      expect(await screen.findByText('-¥35.20')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      getItem.mockRestore();
    }
  });
});

describe('logout', () => {
  function accountSheetTrigger() {
    return screen
      .getAllByRole('button', { name: '账号菜单' })
      .find((button) => button.getAttribute('aria-haspopup') === 'dialog')!;
  }

  it('a failed logout keeps the session and can be retried', async () => {
    let logoutCalls = 0;
    const { location } = renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/home') return { status: 200, body: balance };
      if (path === '/api/auth/logout') {
        logoutCalls += 1;
        return logoutCalls === 1
          ? { status: 503, body: apiError('SERVICE_UNAVAILABLE') }
          : { status: 204 };
      }
      throw new Error(`unexpected ${path}`);
    });
    await screen.findByText('-¥35.20');
    const user = userEvent.setup();
    await user.click(accountSheetTrigger());
    const sheet = await screen.findByRole('dialog', { name: '账号菜单' });
    await user.click(within(sheet).getByRole('button', { name: '退出登录' }));

    expect(await within(sheet).findByRole('alert')).toHaveTextContent(
      '退出失败，请检查网络后重试',
    );
    expect(location()).toBe('/');
    expect(
      screen.getByRole('region', { name: '当前余额', hidden: true }),
    ).toHaveTextContent('-¥35.20');

    await user.click(within(sheet).getByRole('button', { name: '退出登录' }));
    await waitFor(() => expect(location()).toBe('/login'));
    expect(logoutCalls).toBe(2);
  });

  it('the desktop menu shows a logout failure without leaving the page', async () => {
    const { location } = renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/home') return { status: 200, body: balance };
      if (path === '/api/auth/logout') throw new TypeError('network down');
      throw new Error(`unexpected ${path}`);
    });
    await screen.findByText('-¥35.20');
    const user = userEvent.setup();
    screen
      .getAllByRole('button', { name: '账号菜单' })
      .find((button) => button.getAttribute('aria-haspopup') === 'menu')!
      .focus();
    await user.keyboard('{Enter}');
    const menu = await screen.findByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '退出登录' }));
    expect(await within(menu).findByRole('alert')).toHaveTextContent(
      '退出失败，请检查网络后重试',
    );
    expect(location()).toBe('/');
  });

  it('an already expired session (401) counts as logged out', async () => {
    const { location } = renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return { status: 403, body: apiError('ACCOUNT_DISABLED') };
      if (path === '/api/auth/logout')
        return {
          status: 401,
          body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
        };
      throw new Error(`unexpected ${path}`);
    });
    await userEvent.click(
      await screen.findByRole('button', { name: '退出登录' }),
    );
    await waitFor(() => expect(location()).toBe('/login'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a rejected logout on the disabled page stays put with an error', async () => {
    const { location } = renderApp('/admin', (path) => {
      if (path === '/api/auth/session')
        return { status: 403, body: apiError('ACCOUNT_DISABLED') };
      if (path === '/api/auth/logout')
        return { status: 429, body: apiError('RATE_LIMITED') };
      throw new Error(`unexpected ${path}`);
    });
    await userEvent.click(
      await screen.findByRole('button', { name: '退出登录' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '退出失败，请检查网络后重试',
    );
    expect(location()).toBe('/admin');
    expect(
      screen.getByRole('heading', { name: '该管理员账号已停用' }),
    ).toBeVisible();
  });
});

describe('home load errors', () => {
  it('a server error shows a retryable error and recovers on retry', async () => {
    let contextCalls = 0;
    renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/home') {
        contextCalls += 1;
        return contextCalls <= 3
          ? { status: 503, body: apiError('SERVICE_UNAVAILABLE') }
          : { status: 200, body: balance };
      }
      throw new Error(`unexpected ${path}`);
    });
    const alert = await screen.findByRole('alert', {}, { timeout: 6000 });
    expect(alert).toHaveTextContent('加载失败网络异常，请稍后重试');
    expect(contextCalls).toBe(3);
    await userEvent.click(within(alert).getByRole('button', { name: '重试' }));
    expect(
      await screen.findByRole('region', { name: '当前余额' }),
    ).toHaveTextContent('-¥35.20');
    expect(screen.queryByRole('alert')).toBeNull();
  }, 10_000);

  it('the admin overview shows metrics and the empty attention state', async () => {
    renderApp('/admin', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: adminSession };
      if (path === '/api/admin/overview')
        return {
          status: 200,
          body: {
            asOf: '2026-09-30T00:00:00.000Z',
            metrics: {
              tenantCount: 2,
              todayCallMinutes: '0',
              todayCallMinutesByCurrency: { CNY: '0', USD: '0' },
              suspendedTenantsByCurrency: { CNY: 0, USD: 0 },
              todaySpend: { CNY: '0', USD: '0' },
              monthSpend: { CNY: '0', USD: '0' },
              pendingReceivable: { CNY: '0', USD: '0' },
              suspendedTenants: 0,
            },
            attention: {
              suspended: { total: 0, items: [] },
              lowBalance: { total: 0, items: [] },
              unassigned: { pending: 0, latestAt: null },
              alerts: { open: 0, last24h: 0, items: [] },
            },
            dailySpend: Array.from({ length: 30 }, (_, i) => ({
              date: `2026-09-${String(i + 1).padStart(2, '0')}`,
              CNY: '0',
              USD: '0',
            })),
          },
        };
      if (path === '/api/admin/unassigned-cdrs/summary')
        return { status: 200, body: { pending: 0, ignored: 0 } };
      if (path === '/api/admin/system-alerts/summary')
        return {
          status: 200,
          body: { open: 0, last24h: 0, lastOpenedAt: null },
        };
      throw new Error(`unexpected ${path}`);
    });
    expect(await screen.findByText('含已停用')).toBeVisible();
    expect(screen.getByText('一切正常')).toBeVisible();
    // 「已停机」只指余额停机；手动停用的租户同样不能呼叫，所以不能写「全部租户可呼叫」。
    expect(screen.getByText('没有因余额停机')).toBeVisible();
    expect(screen.queryByText('全部租户可呼叫')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'USD' }));
    expect(screen.getByRole('button', { name: 'USD' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('a network failure leaves the admin overview with a retry, not a blank page', async () => {
    let contextCalls = 0;
    renderApp('/admin', (path) => {
      if (path === '/api/auth/session')
        return {
          status: 200,
          body: {
            identity: {
              kind: 'admin',
              profileId: customerSession.identity.profileId,
              name: '王敏',
              email: 'wangmin@example.com',
            },
            expiresAt: customerSession.expiresAt,
            passwordChangeRequired: false,
          },
        };
      if (path === '/api/admin/overview') {
        contextCalls += 1;
        throw new TypeError('network down');
      }
      if (path === '/api/admin/unassigned-cdrs/summary')
        return { status: 200, body: { pending: 0, ignored: 0 } };
      throw new Error(`unexpected ${path}`);
    });
    const alert = await screen.findByRole('alert', {}, { timeout: 6000 });
    expect(alert).toHaveTextContent('加载失败网络异常，请稍后重试');
    expect(within(alert).getByRole('button', { name: '重试' })).toBeEnabled();
    expect(contextCalls).toBe(3);
  }, 10_000);
});

describe('login errors', () => {
  it('shows the lock countdown and disables the form', async () => {
    renderApp('/login', () => ({
      status: 429,
      body: apiError('ACCOUNT_LOCKED', { retryAfterSeconds: 872 }),
    }));
    await signIn('abc001@example.com', 'wrong-password');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('登录失败次数过多，已暂时锁定');
    expect(alert).toHaveTextContent(/请在 14分3[12]秒 后重试/);
    expect(
      screen.getByRole('button', { name: /^请在 14分3[12]秒 后重试$/ }),
    ).toBeDisabled();
    expect(screen.getByLabelText('登录邮箱')).toBeDisabled();
  });

  it('marks the password field for wrong credentials', async () => {
    renderApp('/admin/login', () => ({
      status: 401,
      body: apiError('INVALID_CREDENTIALS'),
    }));
    await signIn('wangmin@example.com', 'wrong-password');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '登录邮箱或密码错误请检查后重新输入',
    );
    expect(screen.getByLabelText('密码')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('sends the identity to its own zone even from the other login page', async () => {
    const { location } = renderApp('/admin/login', (path) => {
      if (path === '/api/auth/login' || path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/home') return { status: 200, body: balance };
      throw new Error(`unexpected ${path}`);
    });
    await signIn('abc001@example.com', 'correct-password');
    await waitFor(() => expect(location()).toBe('/'));
  });
});

describe('404', () => {
  it('renders the not-found page for unknown paths', async () => {
    renderApp('/no-such-page', () => ({
      status: 401,
      body: apiError('UNAUTHENTICATED', { action: 'reauthenticate' }),
    }));
    expect(
      await screen.findByRole('heading', { name: '找不到这个页面' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: '返回首页' })).toHaveAttribute(
      'href',
      '/',
    );
  });
});

it('links the overview alert group and each item to the 24-hour window', async () => {
  const alert = {
    id: '00000000-0000-4000-8000-000000000010',
    kind: 'auth_timeout',
    kindLabel: '授权超时',
    description: '授权超时测试',
    startedAt: '2026-09-29T01:00:00.000Z',
    lastSeenAt: '2026-09-29T01:00:00.000Z',
    recoveredAt: null,
    status: 'open',
    durationSeconds: 60,
    affectedCalls: 1,
    occurrences: 1,
    tenant: null,
  };
  renderApp('/admin', (path) => {
    if (path === '/api/auth/session')
      return { status: 200, body: adminSession };
    if (path === '/api/admin/overview')
      return {
        status: 200,
        body: {
          asOf: '2026-09-30T00:00:00.000Z',
          metrics: {
            tenantCount: 0,
            todayCallMinutes: '0',
            todayCallMinutesByCurrency: { CNY: '0', USD: '0' },
            suspendedTenantsByCurrency: { CNY: 0, USD: 0 },
            todaySpend: { CNY: '0', USD: '0' },
            monthSpend: { CNY: '0', USD: '0' },
            pendingReceivable: { CNY: '0', USD: '0' },
            suspendedTenants: 0,
          },
          attention: {
            suspended: { total: 0, items: [] },
            lowBalance: { total: 0, items: [] },
            unassigned: { pending: 0, latestAt: null },
            alerts: { open: 1, last24h: 1, items: [alert] },
          },
          dailySpend: Array.from({ length: 30 }, (_, i) => ({
            date: `2026-09-${String(i + 1).padStart(2, '0')}`,
            CNY: '0',
            USD: '0',
          })),
        },
      };
    if (path === '/api/admin/unassigned-cdrs/summary')
      return { status: 200, body: { pending: 0, ignored: 0 } };
    if (path === '/api/admin/system-alerts/summary')
      return {
        status: 200,
        body: { open: 1, last24h: 1, lastOpenedAt: alert.startedAt },
      };
    throw new Error(`unexpected ${path}`);
  });
  const items = await screen.findAllByRole('link', { name: /开始于 09:00:00/ });
  expect(screen.queryByText('授权超时测试')).not.toBeInTheDocument();
  expect(items).toHaveLength(2);
  for (const item of items)
    expect(item).toHaveTextContent('开始于 09:00:00 · 已持续 1 分钟');
  const group = screen.getByRole('link', { name: /系统告警 最近 24 小时/ });
  for (const link of [group, ...items])
    expect(
      new URL(link.getAttribute('href')!, 'http://localhost').searchParams.get(
        'window',
      ),
    ).toBe('24h');
});

it('shows the overview skeleton while the snapshot is loading', async () => {
  renderApp('/admin', (path) => {
    if (path === '/api/auth/session')
      return { status: 200, body: adminSession };
    if (path === '/api/admin/overview') return new Promise<never>(() => {});
    if (path === '/api/admin/unassigned-cdrs/summary')
      return { status: 200, body: { pending: 0, ignored: 0 } };
    if (path === '/api/admin/system-alerts/summary')
      return { status: 200, body: { open: 0, last24h: 0, lastOpenedAt: null } };
    throw new Error(`unexpected ${path}`);
  });
  const skeleton = await screen.findByRole('status', { name: '加载概览' });
  expect(
    skeleton.querySelectorAll('[data-slot="skeleton"]').length,
  ).toBeGreaterThan(30);
});
