import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { adminApi, apiError, renderApp } from '../../test/app';
import { passwordGate, sessionExpiry } from '../../lib/session';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

it('shows empty list, mail configuration, validates input and handles a conflict', async () => {
  const user = userEvent.setup();
  let version = 1;
  const { handler, calls } = adminApi({
    'GET /api/admin/system-alerts/summary': () => ({
      status: 200,
      body: { open: 0, last24h: 0, lastOpenedAt: null },
    }),
    'GET /api/admin/system-alerts': () => ({
      status: 200,
      body: {
        items: [],
        pagination: { page: 1, pageSize: 25, total: 0 },
        openCount: 0,
      },
    }),
    'GET /api/admin/alert-settings': () => ({
      status: 200,
      body: {
        recipients: version === 1 ? [] : ['new@example.com'],
        digestMinutes: 15,
        version,
        mailEnabled: false,
      },
    }),
    'PUT /api/admin/alert-settings': () => {
      version = 2;
      return { status: 409, body: apiError('ALERT_SETTINGS_VERSION_CONFLICT') };
    },
  });
  renderApp('/admin/system-alerts', handler);
  expect(await screen.findByText('最近 30 天没有系统告警')).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '设置' }));
  expect(
    await screen.findByText('邮件发送未配置，告警和提醒不会发出'),
  ).toBeVisible();
  expect(screen.getByText('未设置接收邮箱，当前发给全部管理员')).toBeVisible();
  await user.type(screen.getByLabelText('告警接收邮箱'), 'bad{Enter}');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(screen.getByText(/请输入有效邮箱/)).toBeVisible();
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: '移除 bad' }));
  await user.type(
    screen.getByLabelText('告警接收邮箱'),
    'ops@example.com{Enter}',
  );
  expect(
    screen.getByRole('button', { name: '移除 ops@example.com' }),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '移除 new@example.com' }),
    ).toBeVisible(),
  );
  expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
    recipients: ['ops@example.com'],
    digestMinutes: 15,
    expectedVersion: 1,
  });
  expect(screen.getByRole('alert')).toHaveTextContent('您未保存的输入已被替换');
  expect(screen.getByRole('alert')).toHaveTextContent('ops@example.com');
});

it('expands alert details and links to the matching unassigned reason', async () => {
  const user = userEvent.setup();
  const alert = {
    id: '00000000-0000-4000-8000-000000000010',
    kind: 'cdr_failed',
    kindLabel: '话单处理失败',
    description: '缺少字段',
    startedAt: '2026-09-29T01:00:00.000Z',
    lastSeenAt: '2026-09-29T01:00:00.000Z',
    recoveredAt: null,
    status: 'open',
    durationSeconds: 60,
    affectedCalls: 0,
    occurrences: 1,
    tenant: null,
  };
  const { handler } = adminApi({
    'GET /api/admin/system-alerts/summary': () => ({
      status: 200,
      body: { open: 1, last24h: 1, lastOpenedAt: alert.startedAt },
    }),
    'GET /api/admin/system-alerts': () => ({
      status: 200,
      body: {
        items: [alert],
        pagination: { page: 1, pageSize: 25, total: 1 },
        openCount: 1,
      },
    }),
    [`GET /api/admin/system-alerts/${alert.id}`]: () => ({
      status: 200,
      body: {
        ...alert,
        notify: true,
        affectedTenants: null,
        cdrRange: null,
        unassignedFilter: { reason: '缺少 billsec', tag: null },
        notices: [],
      },
    }),
  });
  renderApp('/admin/system-alerts', handler);
  expect(await screen.findByLabelText('有进行中的告警')).toBeInTheDocument();
  const table = await screen.findByRole('table', { name: '系统告警' });
  await user.click(within(table).getByRole('button'));
  expect(await screen.findByText('暂无通知记录')).toBeVisible();
  const href = screen
    .getByRole('link', { name: '查看这 0 通话单 ›' })
    .getAttribute('href');
  expect(new URL(href!, 'http://localhost').searchParams.get('reason')).toBe(
    '缺少 billsec',
  );
});

it.each([1, 2])(
  'only offers the primary CDR button for one affected tenant (%i)',
  async (count) => {
    const user = userEvent.setup();
    const instant = new Date();
    const timestamp = instant.toISOString();
    const day = timestamp.slice(0, 10);
    const tenants = [
      {
        id: '00000000-0000-4000-8000-000000000021',
        code: 'ABC001',
        name: '租户甲',
        count: 4,
      },
      {
        id: '00000000-0000-4000-8000-000000000022',
        code: 'XYZ002',
        name: '租户乙',
        count: 11,
      },
    ].slice(0, count);
    const alert = {
      id: '00000000-0000-4000-8000-000000000010',
      kind: 'auth_timeout',
      kindLabel: '授权超时',
      description: '授权超时',
      startedAt: timestamp,
      lastSeenAt: timestamp,
      recoveredAt: null,
      status: 'open',
      durationSeconds: 60,
      affectedCalls: 23,
      occurrences: 1,
      tenant: null,
    };
    const { handler } = adminApi({
      'GET /api/admin/system-alerts': () => ({
        status: 200,
        body: {
          items: [alert],
          pagination: { page: 1, pageSize: 25, total: 1 },
          openCount: 1,
        },
      }),
      [`GET /api/admin/system-alerts/${alert.id}`]: () => ({
        status: 200,
        body: {
          ...alert,
          notify: true,
          affectedTenants: { items: tenants, truncated: false },
          cdrRange: {
            from: timestamp,
            to: timestamp,
            fromDay: day,
            toDay: day,
          },
          unassignedFilter: null,
          notices: [],
        },
      }),
    });
    renderApp('/admin/system-alerts', handler);
    const table = await screen.findByRole('table', { name: '系统告警' });
    await user.click(within(table).getByRole('button'));
    expect(await screen.findByText('暂无通知记录')).toBeVisible();
    expect(
      screen.getByRole('link', { name: /ABC001 · 租户甲 · 4 通/ }),
    ).toBeVisible();
    if (count === 1) {
      expect(
        screen.getByRole('link', { name: '查看这 4 通话单 ›' }),
      ).toHaveAttribute('href', expect.stringContaining(tenants[0]!.id));
    } else {
      expect(
        screen.getByRole('link', { name: /XYZ002 · 租户乙 · 11 通/ }),
      ).toBeVisible();
      expect(
        screen.queryByRole('link', { name: /查看这 .* 通话单/ }),
      ).not.toBeInTheDocument();
    }
  },
);

it('clears a filtered empty state', async () => {
  const user = userEvent.setup();
  const { handler, calls } = adminApi({
    'GET /api/admin/system-alerts': () => ({
      status: 200,
      body: {
        items: [],
        pagination: { page: 1, pageSize: 25, total: 0 },
        openCount: 0,
      },
    }),
  });
  renderApp('/admin/system-alerts?window=24h', handler);
  expect(await screen.findByText('没有符合筛选条件的系统告警')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '清除筛选' }));
  expect(await screen.findByText('最近 30 天没有系统告警')).toBeVisible();
  expect(calls.some((c) => c.path.includes('window=30d'))).toBe(true);
});
