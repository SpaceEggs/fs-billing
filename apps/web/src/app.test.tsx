import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiry } from './lib/session';
import { apiError, customerSession, renderApp } from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
});

const balance = {
  identity: customerSession.identity,
  balance: { currency: 'CNY', amount: '-35.2' },
};

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
      if (path === '/api/portal/context') {
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
    expect(screen.getByRole('status')).toHaveTextContent(
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
    expect(
      await screen.findAllByText('ABC001 · 深圳市某某科技有限公司'),
    ).not.toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
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
      if (path === '/api/portal/context') return { status: 200, body: balance };
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
