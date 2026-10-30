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
  expect(await screen.findByText('没有系统告警')).toBeVisible();
  await user.click(screen.getByRole('tab', { name: '设置' }));
  expect(
    await screen.findByText('邮件发送未配置，告警和提醒不会发出'),
  ).toBeVisible();
  expect(screen.getByText('未设置接收邮箱，当前发给全部管理员')).toBeVisible();
  await user.type(screen.getByLabelText('告警接收邮箱'), 'bad');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(screen.getByText(/请输入有效邮箱/)).toBeVisible();
  expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  await user.clear(screen.getByLabelText('告警接收邮箱'));
  await user.type(screen.getByLabelText('告警接收邮箱'), 'ops@example.com');
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(screen.getByLabelText('告警接收邮箱')).toHaveValue(
      'new@example.com',
    ),
  );
  expect(
    screen.getByText('告警设置已被其他人修改，已重新加载当前设置'),
  ).toBeVisible();
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
  expect(screen.getByRole('link', { name: '查看未归属话单' })).toHaveAttribute(
    'href',
    expect.stringContaining('reason='),
  );
});
