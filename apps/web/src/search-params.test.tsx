import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  validateAdminStatementsSearch,
  validateAuditLogSearch,
  validateTenantDetailSearch,
  validateUnassignedSearch,
} from './lib/admin-search';
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

describe('tenant detail search', () => {
  it('knows the CDR tab and its filters, dropping each bad one on its own', () => {
    expect(
      validateTenantDetailSearch({
        tab: 'cdrs',
        from: '2026-10-01',
        to: '2026-10-09',
        callee: 447,
        country: '英国',
        status: 'all',
        unverifiedOnly: true,
        page: 2,
      }),
    ).toEqual({
      tab: 'cdrs',
      from: '2026-10-01',
      to: '2026-10-09',
      kind: undefined,
      callee: '447',
      country: '英国',
      status: 'all',
      unverifiedOnly: true,
      page: 2,
    });
    expect(
      validateTenantDetailSearch({
        tab: 'cdrs',
        status: 'bogus',
        unverifiedOnly: 'yes',
        country: '',
        page: 0,
      }),
    ).toMatchObject({
      tab: 'cdrs',
      status: undefined,
      unverifiedOnly: undefined,
      country: undefined,
      page: undefined,
    });
  });
});

describe('unassigned search', () => {
  it('keeps an empty or numeric tag and drops a bad tab and page', () => {
    expect(
      validateUnassignedSearch({ tab: 'ignored', tag: '', page: 3 }),
    ).toEqual({ tab: 'ignored', tag: '', page: 3 });
    // 路由把纯数字查询串收成 number，校验要还原成字符串。
    expect(
      validateUnassignedSearch({ tab: 'pending', tag: 326, page: 1 }),
    ).toEqual({ tab: undefined, tag: '326', page: undefined });
    expect(validateUnassignedSearch({ tag: '01' })).toEqual({
      tab: undefined,
      tag: '01',
      page: undefined,
    });
    expect(
      validateUnassignedSearch({ tab: 'nope', tag: true, page: 'abc' }),
    ).toEqual({ tab: undefined, tag: undefined, page: undefined });
  });
});

describe('audit log search', () => {
  it('keeps each audit-log filter on its own and drops a reversed end date', () => {
    const adminId = '00000000-0000-4000-8000-000000000009';
    const tenantId = '00000000-0000-4000-8000-00000000a001';
    expect(
      validateAuditLogSearch({
        from: '2026-09-01',
        to: '2026-09-29',
        adminId,
        label: 'cdr_delete',
        tenantId,
        page: 2,
      }),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-09-29',
      adminId,
      label: 'cdr_delete',
      tenantId,
      page: 2,
    });
    expect(validateAuditLogSearch({ page: 1 })).toEqual({
      from: undefined,
      to: undefined,
      adminId: undefined,
      label: undefined,
      tenantId: undefined,
      page: undefined,
    });
    expect(
      validateAuditLogSearch({
        from: 'yesterday',
        to: '2026-09-29',
        adminId: 'wang',
        label: '删除话单',
        tenantId: 'ABC001',
        page: 0,
      }),
    ).toEqual({
      from: undefined,
      to: '2026-09-29',
      adminId: undefined,
      label: undefined,
      tenantId: undefined,
      page: undefined,
    });
    // 开始晚于结束时契约拒绝整段查询，所以只丢掉结束日。
    expect(
      validateAuditLogSearch({ from: '2026-09-29', to: '2026-08-31' }),
    ).toEqual({
      from: '2026-09-29',
      to: undefined,
      adminId: undefined,
      label: undefined,
      tenantId: undefined,
      page: undefined,
    });
  });
});

describe('statement search', () => {
  it('keeps the statements tab month apart from the ledger and CDR ranges', () => {
    expect(
      validateTenantDetailSearch({
        tab: 'statements',
        statementMonth: '2026-08',
        from: '2026-10-01',
        cdrFrom: '2026-09-01',
      }),
    ).toMatchObject({
      tab: 'statements',
      statementMonth: '2026-08',
      from: '2026-10-01',
      cdrFrom: '2026-09-01',
    });
    expect(
      validateTenantDetailSearch({
        tab: 'statements',
        statementMonth: '2026-13',
      }).statementMonth,
    ).toBeUndefined();
    expect(
      validateTenantDetailSearch({
        tab: 'statements',
        statementMonth: '2026-8',
      }).statementMonth,
    ).toBeUndefined();
  });

  it('accepts only YYYY-MM as the statements page month', () => {
    expect(validateAdminStatementsSearch({ month: '2026-08' })).toEqual({
      month: '2026-08',
    });
    expect(validateAdminStatementsSearch({ month: '2026-08-01' })).toEqual({
      month: undefined,
    });
    expect(validateAdminStatementsSearch({ month: 202608 })).toEqual({
      month: undefined,
    });
  });
});
