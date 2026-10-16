import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordGate, sessionExpiry } from './lib/session';
import { adminApi, page, renderApp } from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

const gets = (calls: { path: string; method: string }[], prefix: string) =>
  calls
    .filter((call) => call.method === 'GET' && call.path.startsWith(prefix))
    .map((call) => call.path);

describe('malformed list search params never reach the API', () => {
  it('tenant list drops an unknown status, currency and page but keeps a valid search', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page([]) }),
    });
    renderApp(
      '/admin/tenants?status=bogus&currency=XYZ&page=abc&search=ABC01',
      handler,
    );
    expect(await screen.findByText('没有符合条件的租户')).toBeVisible();
    expect(gets(calls, '/api/admin/tenants')).toEqual([
      '/api/admin/tenants?page=1&pageSize=25&search=ABC01&sort=status_currency_balance',
    ]);
  });

  it('receivables fall back to pending for an unknown status and drop a bad currency and page', async () => {
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
    renderApp(
      '/admin/receivables?status=bogus&currency=XYZ&page=0&search=GZT',
      handler,
    );
    expect(await screen.findByText('没有符合条件的待收款')).toBeVisible();
    expect(gets(calls, '/api/admin/receivables')).toEqual([
      '/api/admin/receivables?page=1&pageSize=25&search=GZT&status=pending',
    ]);
  });

  it('admin accounts drop a bad page and an over-long search', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/admins': () => ({ status: 200, body: page([]) }),
    });
    renderApp(`/admin/admins?page=-2&search=${'x'.repeat(201)}`, handler);
    expect(await screen.findByText('共 0 位 · 0 位启用')).toBeVisible();
    expect(gets(calls, '/api/admin/admins').sort()).toEqual([
      '/api/admin/admins?page=1&pageSize=1&status=active',
      '/api/admin/admins?page=1&pageSize=25',
    ]);
  });
});
