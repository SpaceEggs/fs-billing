import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  AdminMailDelivery,
  AdminMailSettingsEnvironment,
  AdminMailSettingsResponse,
} from '@fs-billing/shared';
import { adminApi, adminSession, apiError, renderApp } from '../../test/app';
import { passwordGate, sessionExpiry } from '../../lib/session';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

const emptyEnv: AdminMailSettingsEnvironment = {
  host: null,
  port: null,
  secure: null,
  username: null,
  mailFrom: null,
  siteUrl: null,
};

type MailOverrides = Partial<
  Omit<AdminMailSettingsResponse, 'env' | 'delivery'>
> & {
  env?: Partial<AdminMailSettingsEnvironment>;
  delivery?: Partial<AdminMailDelivery>;
};

function mailSettings(
  overrides: MailOverrides = {},
): AdminMailSettingsResponse {
  return {
    managed: false,
    enabled: false,
    host: null,
    port: null,
    secure: null,
    username: null,
    passwordSet: false,
    mailFrom: null,
    siteUrl: null,
    version: 1,
    lastTestAt: null,
    lastTestOk: null,
    lastTestResult: null,
    source: 'none',
    keyConfigured: true,
    passwordUsable: true,
    allowPlaintext: true,
    ...overrides,
    env: { ...emptyEnv, ...overrides.env },
    delivery: {
      lastSentAt: null,
      pendingCount: 0,
      lastAttemptFailed: false,
      ...overrides.delivery,
    },
  };
}

const pageConfigured = mailSettings({
  managed: true,
  enabled: true,
  host: 'smtp.example.com',
  port: 465,
  secure: true,
  username: 'ops@example.com',
  passwordSet: true,
  mailFrom: 'ops@example.com',
  source: 'page',
});

it.each([
  ['未配置', mailSettings(), '邮件发送未配置'],
  [
    '环境变量',
    mailSettings({
      source: 'env',
      env: {
        host: 'smtp.example.com',
        port: 465,
        secure: true,
        username: 'ops@example.com',
        mailFrom: 'ops@example.com',
      },
    }),
    '当前使用服务器环境变量里的配置',
  ],
  [
    '缺少加密密钥',
    mailSettings({ source: 'page', keyConfigured: false }),
    '服务器还没有配置 SETTINGS_ENCRYPTION_KEY',
  ],
  [
    '密码无法解密',
    mailSettings({
      ...pageConfigured,
      passwordUsable: false,
    }),
    '已保存的密码无法解密',
  ],
])('shows the %s alert', async (_label, body, text) => {
  const { handler } = adminApi({
    'GET /api/admin/mail-settings': () => ({ status: 200, body }),
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  expect(await screen.findByText(new RegExp(text))).toBeVisible();
});

it('uses the env values read-only until the page takes over', async () => {
  const user = userEvent.setup();
  const body = mailSettings({
    source: 'env',
    env: {
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'ops@example.com',
      mailFrom: 'ops@example.com',
    },
  });
  const { handler } = adminApi({
    'GET /api/admin/mail-settings': () => ({ status: 200, body }),
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  expect(
    await screen.findByText('当前使用服务器环境变量里的配置'),
  ).toBeVisible();
  const host = screen.getByLabelText('SMTP 服务器');
  expect(host).toHaveValue('smtp.example.com');
  expect(host).toHaveAttribute('readonly');
  const username = screen.getByLabelText('账号');
  expect(username).toHaveAttribute('readonly');
  expect(screen.queryByLabelText(/密码或授权码/)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '改由页面管理' }));
  expect(screen.getByLabelText('SMTP 服务器')).not.toHaveAttribute('readonly');
  expect(screen.getByLabelText('账号')).not.toHaveAttribute('readonly');
  expect(screen.getByLabelText(/密码或授权码/)).toBeRequired();
  expect(screen.getByRole('button', { name: '保存' })).toBeVisible();
});

it('fills the QQ preset and follows the account for the sender', async () => {
  const user = userEvent.setup();
  const { handler } = adminApi({
    'GET /api/admin/mail-settings': () => ({
      status: 200,
      body: pageConfigured,
    }),
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  expect(await screen.findByText('已设置')).toBeVisible();
  expect(screen.queryByLabelText(/密码或授权码/)).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '更改' }));
  const password = screen.getByLabelText(/密码或授权码/);
  expect(password).toBeVisible();
  expect(password).not.toBeRequired();

  await user.click(screen.getByRole('radio', { name: 'QQ 邮箱' }));
  expect(screen.getByLabelText('SMTP 服务器')).toHaveValue('smtp.qq.com');
  expect(screen.getByLabelText('端口')).toHaveValue('465');
  expect(screen.getByRole('radio', { name: '隐式 TLS' })).toBeChecked();

  const username = screen.getByLabelText('账号');
  await user.clear(username);
  await user.type(username, 'me@qq.com');
  expect(screen.getByLabelText('发件人邮箱')).toHaveValue('me@qq.com');
  expect(screen.getByText('QQ 邮箱要求和账号相同')).toBeVisible();
  expect(screen.getByLabelText('授权码')).toBeVisible();
});

it('asks for a new password after the host changes', async () => {
  const user = userEvent.setup();
  const { handler } = adminApi({
    'GET /api/admin/mail-settings': () => ({
      status: 200,
      body: pageConfigured,
    }),
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  expect(await screen.findByText('已设置')).toBeVisible();
  expect(screen.queryByLabelText(/密码或授权码/)).not.toBeInTheDocument();

  const host = screen.getByLabelText('SMTP 服务器');
  await user.clear(host);
  await user.type(host, 'smtp.other.example.com');
  expect(screen.getByLabelText(/密码或授权码/)).toBeRequired();
  expect(
    screen.getByText('服务器或账号改过了，请重新填写密码或授权码。'),
  ).toBeVisible();
});

it('shows server validation errors under the matching fields', async () => {
  const user = userEvent.setup();
  const { handler, calls } = adminApi({
    'GET /api/admin/mail-settings': () => ({
      status: 200,
      body: pageConfigured,
    }),
    'PUT /api/admin/mail-settings': () => ({
      status: 400,
      body: apiError('VALIDATION_ERROR', {
        issues: [
          { path: ['host'], message: '服务器地址无效' },
          { path: ['port'], message: '端口只允许 25、465、587 或 2525' },
        ],
      }),
    }),
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  await screen.findByText('已设置');
  await user.click(screen.getByRole('button', { name: '保存' }));

  expect(
    await screen.findByText('提交内容有误，请检查标红的字段'),
  ).toBeVisible();
  const hostError = screen
    .getAllByText('服务器地址无效')
    .find((element) => element.id !== '');
  const portError = screen
    .getAllByText('端口只允许 25、465、587 或 2525')
    .find((element) => element.id !== '');
  expect(hostError).toBeDefined();
  expect(portError).toBeDefined();
  expect(screen.getByLabelText('SMTP 服务器')).toHaveAttribute(
    'aria-describedby',
    hostError!.id,
  );
  expect(screen.getByLabelText('SMTP 服务器')).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  expect(screen.getByLabelText('端口')).toHaveAttribute(
    'aria-describedby',
    portError!.id,
  );
  expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({
    host: 'smtp.example.com',
    port: 465,
  });
});

it('saves without sending a password that was not re-entered', async () => {
  const user = userEvent.setup();
  const { handler, calls } = adminApi({
    'GET /api/admin/mail-settings': () => ({
      status: 200,
      body: pageConfigured,
    }),
    'PUT /api/admin/mail-settings': () => ({
      status: 200,
      body: {
        ...pageConfigured,
        version: 2,
        auditId: '00000000-0000-4000-8000-000000000099',
      },
    }),
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  await screen.findByText('已设置');
  expect(document.querySelector('input[type="password"]')).toBeNull();

  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(await screen.findByText('设置已保存')).toBeVisible();
  const saved = calls.find((call) => call.method === 'PUT')?.body as
    Record<string, unknown> | undefined;
  expect(saved).toBeDefined();
  expect(saved).not.toHaveProperty('password');
});

it('reloads the latest settings after a version conflict', async () => {
  const user = userEvent.setup();
  let version = 1;
  let host = 'old.example.com';
  const { handler, calls } = adminApi({
    'GET /api/admin/mail-settings': () => ({
      status: 200,
      body: { ...pageConfigured, version, host },
    }),
    'PUT /api/admin/mail-settings': () => {
      version = 2;
      host = 'new.example.com';
      return { status: 409, body: apiError('MAIL_SETTINGS_VERSION_CONFLICT') };
    },
  });
  renderApp('/admin/system-alerts?tab=mail', handler);
  expect(await screen.findByLabelText('SMTP 服务器')).toHaveValue(
    'old.example.com',
  );
  await user.click(screen.getByRole('button', { name: '保存' }));
  await waitFor(() =>
    expect(calls.some((call) => call.method === 'PUT')).toBe(true),
  );
  const alerts = screen.getAllByRole('alert').map((alert) => alert.textContent);
  expect(alerts.join('|')).toContain('邮箱设置已被其他人修改');
  expect(screen.getByLabelText('SMTP 服务器')).toHaveValue('new.example.com');
});

it.each([
  ['ok', '测试邮件已发送', /服务器已接受，请到 WangMin@example\.com 查收/],
  [
    'auth',
    '测试邮件发送失败：认证错误',
    /账号或授权码不对。配置没有保存，也没有改变。/,
  ],
  [
    'retry',
    '测试邮件发送失败：连接失败或超时',
    /请检查服务器、端口、加密方式和服务器的出站网络。/,
  ],
  ['permanent', '测试邮件发送失败：被拒收', /请检查发件人和收件人。/],
] as const)(
  'sends a test mail and shows the %s result',
  async (result, title, bodyText) => {
    const user = userEvent.setup();
    const { handler, calls } = adminApi({
      'GET /api/admin/mail-settings': () => ({
        status: 200,
        body: pageConfigured,
      }),
      'POST /api/admin/mail-settings/test': () => ({
        status: 200,
        body: { ok: result === 'ok', result },
      }),
    });
    renderApp('/admin/system-alerts?tab=mail', handler);
    await screen.findByText('已设置');
    await user.click(screen.getByRole('button', { name: '发送测试邮件' }));
    const dialog = screen.getByRole('dialog', { name: '发送测试邮件' });
    expect(
      within(dialog).getByText(
        '用表单里当前填写的配置发送，即使还没保存。发送不会改变已保存的配置。',
      ),
    ).toBeVisible();
    expect(within(dialog).getByLabelText('收件人')).toHaveValue(
      adminSession.identity.email,
    );
    await user.click(within(dialog).getByRole('button', { name: '发送' }));

    expect(await screen.findByText(title)).toBeVisible();
    expect(screen.getByText(bodyText)).toBeVisible();
    await waitFor(() =>
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument(),
    );
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
      to: adminSession.identity.email,
      host: 'smtp.example.com',
      port: 465,
    });
  },
);

it('keeps the old tab=settings link and exposes all three tabs', async () => {
  const user = userEvent.setup();
  const { handler } = adminApi({
    'GET /api/admin/alert-settings': () => ({
      status: 200,
      body: {
        recipients: [],
        digestMinutes: 15,
        version: 1,
        mailEnabled: false,
      },
    }),
    'GET /api/admin/mail-settings': () => ({
      status: 200,
      body: mailSettings(),
    }),
  });
  renderApp('/admin/system-alerts?tab=settings', handler);
  expect(await screen.findByRole('tab', { name: '告警设置' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(screen.getByRole('tab', { name: '告警列表' })).toBeVisible();
  expect(screen.getByRole('tab', { name: '邮箱设置' })).toBeVisible();
  expect(await screen.findByText('告警接收邮箱')).toBeVisible();

  await user.click(screen.getByRole('link', { name: '去邮箱设置' }));
  expect(await screen.findByRole('tab', { name: '邮箱设置' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(await screen.findByText('启用邮件发送')).toBeVisible();
});
