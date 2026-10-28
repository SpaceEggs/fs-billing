import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordGate, sessionExpiry } from '../../lib/session';
import { adminApi, renderApp, type ApiHandler } from '../../test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

const ids = {
  wang: '00000000-0000-4000-8000-000000000009',
  li: '00000000-0000-4000-8000-00000000000a',
  tenant: '00000000-0000-4000-8000-00000000a001',
  delete: '00000000-0000-4000-8000-00000000c001',
  adjust: '00000000-0000-4000-8000-00000000c002',
  topup: '00000000-0000-4000-8000-00000000c003',
  credit: '00000000-0000-4000-8000-00000000c005',
  system: '00000000-0000-4000-8000-00000000c004',
};

const tenant = {
  id: ids.tenant,
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
};

const admin = (id: string, name: string, email: string) => ({
  id,
  name,
  email,
  status: 'active' as const,
  lastLoginAt: '2026-09-28T10:47:05.000Z',
  createdAt: '2026-08-01T00:00:00.000Z',
});

const listedTenant = {
  ...tenant,
  currency: 'CNY' as const,
  status: 'active' as const,
  health: 'overdraft' as const,
  settingsConfigured: true,
  balance: '-35.2',
  overdraftLimit: '100',
  availableBalance: '64.8',
  monthConsumption: '0',
  pendingReceivable: '0',
};

function log(overrides: Record<string, unknown>) {
  return {
    id: ids.delete,
    occurredAt: '2026-09-29T07:42:10.000Z',
    actor: { kind: 'admin', id: ids.wang, name: '王敏' },
    action: 'cdr_delete',
    label: 'cdr_delete',
    tenant,
    target: { kind: 'tenant', id: ids.tenant },
    summary: '删除 ABC001 2026年8月话单',
    changes: [
      { field: 'callCount', before: '9642', after: '0' },
      {
        field: 'emails',
        before: ['ops@example.com', 'finance@example.com'],
        after: null,
      },
    ],
    ...overrides,
  };
}

const rows = [
  log({}),
  log({
    id: ids.adjust,
    occurredAt: '2026-09-28T08:20:55.000Z',
    actor: { kind: 'admin', id: ids.li, name: '李俊' },
    action: 'balance_adjustment',
    label: 'balance',
    summary: '调账 -35.20',
    changes: [{ field: 'balance', before: '-35.2', after: '0' }],
  }),
  log({
    id: ids.topup,
    occurredAt: '2026-09-27T01:00:00.000Z',
    action: 'balance_topup',
    label: 'balance',
    summary: '充值 100',
    changes: [{ field: 'amount', before: null, after: '100' }],
  }),
  log({
    id: ids.credit,
    occurredAt: '2026-09-28T08:20:55.000Z',
    action: 'balance_credit_topup',
    label: 'balance',
    summary: '赊账充值 300',
    changes: [{ field: 'balance', before: '0', after: '300' }],
  }),
  log({
    id: ids.system,
    occurredAt: '2026-09-01T00:00:00.000Z',
    actor: { kind: 'system', label: 'cli:auth:bootstrap@host/ops' },
    action: 'credential_bootstrap',
    label: 'account',
    tenant: null,
    target: null,
    summary: '初始化管理员',
    changes: [],
  }),
];

function body(items: unknown[], total = items.length) {
  return {
    range: { from: '2026-09-01', to: '2026-09-30' },
    items,
    pagination: { page: 1, pageSize: 50, total },
  };
}

function renderLogs(
  path = '/admin/audit-logs',
  items: unknown[] = rows,
  total = items.length,
) {
  const { calls, handler } = adminApi({
    'GET /api/admin/audit-logs': () => ({
      status: 200,
      body: body(items, total),
    }),
    'GET /api/admin/admins': () => ({
      status: 200,
      body: {
        items: [
          admin(ids.wang, '王敏', 'wangmin@example.com'),
          admin(ids.li, '李俊', 'lijun@example.com'),
        ],
        pagination: { page: 1, pageSize: 100, total: 2 },
      },
    }),
    'GET /api/admin/tenants': () => ({
      status: 200,
      body: {
        items: [listedTenant],
        pagination: { page: 1, pageSize: 100, total: 1 },
      },
    }),
  } satisfies Record<string, ApiHandler>);
  return { calls, ...renderApp(path, handler) };
}

const auditParams = (path: string) =>
  new URL(path, 'http://localhost').searchParams;

const rowOf = (text: string) => {
  const table = screen.getByRole('table', { name: '操作记录' });
  const found = within(table)
    .getAllByRole('row')
    .find((candidate) => candidate.textContent?.includes(text));
  if (!found) throw new Error(`no row for ${text}`);
  return found;
};

describe('audit logs', () => {
  it('shows tone by action, the system actor, and the before/after of an expanded row', async () => {
    const user = userEvent.setup();
    const { calls } = renderLogs('/admin/audit-logs', rows, 120);
    await screen.findByRole('table', { name: '操作记录' });
    expect(screen.getByRole('heading', { name: '操作日志' })).toBeVisible();
    expect(screen.getByText('只读 · 记录不可修改或删除')).toBeVisible();
    expect(screen.getByText('共 120 条 · 第 1–50 条')).toBeVisible();
    expect(
      screen.getByRole('button', {
        name: '日期范围：2026-09-01 至 2026-09-30',
      }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        calls.some((call) => {
          const params = auditParams(call.path);
          return (
            call.path.startsWith('/api/admin/audit-logs') &&
            params.get('page') === '1' &&
            params.get('pageSize') === '50' &&
            params.get('from') === null
          );
        }),
      ).toBe(true),
    );

    const deleted = rowOf('删除 ABC001 2026年8月话单');
    expect(within(deleted).getByText('2026-09-29 15:42:10')).toBeVisible();
    expect(within(deleted).getByText('王敏')).toBeVisible();
    expect(within(deleted).getByText('删除话单')).toHaveClass('bg-err-soft');
    expect(within(deleted).getByText('ABC001')).toBeVisible();
    expect(
      within(rowOf('调账 -35.20')).getByText('充值 / 赠送 / 调账'),
    ).toHaveClass('bg-warn-soft');
    expect(
      within(rowOf('充值 100')).getByText('充值 / 赠送 / 调账'),
    ).toHaveClass('bg-brand-soft');
    expect(
      within(rowOf('赊账充值 300')).getByText('充值 / 赠送 / 调账'),
    ).toHaveClass('bg-warn-soft');

    const system = rowOf('初始化管理员');
    expect(
      within(system).getByText('cli:auth:bootstrap@host/ops'),
    ).toBeVisible();
    expect(within(system).getByText('账号')).toHaveClass('bg-brand-soft');
    expect(within(system).getByText('—')).toBeVisible();
    await user.click(system);
    expect(system).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('table', { name: '修改前后' })).toBeNull();
    expect(
      screen.getAllByText(
        '操作人 cli:auth:bootstrap@host/ops · 2026-09-01 08:00:00 · 只读记录',
      ).length,
    ).toBeGreaterThan(0);

    await user.click(deleted);
    const changes = screen.getByRole('table', { name: '修改前后' });
    expect(
      within(changes)
        .getAllByRole('columnheader')
        .map((header) => header.textContent),
    ).toEqual(['字段', '修改前', '修改后']);
    expect(within(changes).getByRole('cell', { name: '条数' })).toBeVisible();
    expect(within(changes).getByRole('cell', { name: '9642' })).toHaveClass(
      'line-through',
    );
    expect(within(changes).getByRole('cell', { name: '0' })).toBeVisible();
    expect(
      within(changes).getByRole('cell', { name: '通知邮箱' }),
    ).toBeVisible();
    expect(
      within(changes).getByRole('cell', {
        name: 'ops@example.com、finance@example.com',
      }),
    ).toHaveClass('line-through');
    expect(within(changes).getByRole('cell', { name: '—' })).not.toHaveClass(
      'line-through',
    );
    expect(changes.parentElement).toHaveTextContent(
      '操作人 王敏 · 2026-09-29 15:42:10 · 只读记录',
    );
    const card = screen.getByRole('button', {
      name: /删除 ABC001 2026年8月话单/,
    });
    expect(card).toHaveAttribute('aria-expanded', 'true');
    expect(card).toHaveTextContent('9642');
    expect(card).toHaveTextContent('→');
    expect(card).toHaveTextContent('只读记录');

    await user.click(screen.getByRole('button', { name: '下一页' }));
    await waitFor(() =>
      expect(
        calls.some((call) => auditParams(call.path).get('page') === '2'),
      ).toBe(true),
    );
  });

  it('writes each filter into the address and drops invalid values on their own', async () => {
    const user = userEvent.setup();
    const { calls, location } = renderLogs(
      `/admin/audit-logs?from=yesterday&to=2026-09-29&adminId=wang&label=${encodeURIComponent('删除话单')}&tenantId=ABC001&page=0`,
    );
    await screen.findByRole('table', { name: '操作记录' });
    await waitFor(() => {
      const params = new URL(location(), 'http://localhost').searchParams;
      expect(params.get('to')).toBe('2026-09-29');
      expect(params.get('from')).toBeNull();
      expect(params.get('adminId')).toBeNull();
      expect(params.get('label')).toBeNull();
      expect(params.get('tenantId')).toBeNull();
      expect(params.get('page')).toBeNull();
    });
    const asked = calls.filter((call) =>
      call.path.startsWith('/api/admin/audit-logs'),
    );
    expect(asked.length).toBeGreaterThan(0);
    for (const call of asked) {
      const params = auditParams(call.path);
      expect(params.get('to')).toBe('2026-09-29');
      expect(params.get('from')).toBeNull();
      expect(params.get('adminId')).toBeNull();
      expect(params.get('label')).toBeNull();
      expect(params.get('tenantId')).toBeNull();
      expect(params.get('page')).toBe('1');
      expect(params.get('pageSize')).toBe('50');
    }
    expect(
      screen.getByRole('button', {
        name: '日期范围：2026-09-01 至 2026-09-30',
      }),
    ).toBeVisible();

    await user.selectOptions(
      screen.getByRole('combobox', { name: '管理员' }),
      await screen.findByRole('option', { name: '王敏' }),
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '操作类型' }),
      screen.getByRole('option', { name: '删除话单' }),
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: '租户' }),
      screen.getByRole('option', { name: 'ABC001 深圳市某某科技有限公司' }),
    );
    await waitFor(() => {
      const params = new URL(location(), 'http://localhost').searchParams;
      expect(params.get('adminId')).toBe(ids.wang);
      expect(params.get('label')).toBe('cdr_delete');
      expect(params.get('tenantId')).toBe(ids.tenant);
      expect(params.get('to')).toBe('2026-09-29');
      expect(params.get('page')).toBeNull();
    });
    expect(
      calls.some((call) => {
        const params = auditParams(call.path);
        return (
          params.get('adminId') === ids.wang &&
          params.get('label') === 'cdr_delete' &&
          params.get('tenantId') === ids.tenant
        );
      }),
    ).toBe(true);

    await user.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() => expect(location()).toBe('/admin/audit-logs'));
    await waitFor(() =>
      expect(
        calls.some((call) => {
          if (!call.path.startsWith('/api/admin/audit-logs')) return false;
          const params = auditParams(call.path);
          return (
            params.get('to') === null &&
            params.get('adminId') === null &&
            params.get('label') === null &&
            params.get('tenantId') === null
          );
        }),
      ).toBe(true),
    );
  });

  it('shows the empty state for the current filters and clears them', async () => {
    const user = userEvent.setup();
    const { location } = renderLogs(
      `/admin/audit-logs?adminId=${ids.wang}&label=cdr_delete&tenantId=${ids.tenant}`,
      [],
    );
    expect(await screen.findByText('没有符合条件的操作记录')).toBeVisible();
    expect(
      await screen.findByText(
        '管理员：王敏 · 操作：删除话单 · 租户：ABC001 · 最近 30 天',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(location()).toBe('/admin/audit-logs'));
    expect(screen.getByText('最近 30 天')).toBeVisible();
    expect(screen.queryByText(/管理员：王敏/)).toBeNull();
  });
});
