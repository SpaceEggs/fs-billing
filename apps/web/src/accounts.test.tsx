import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordGate, sessionExpiry } from './lib/session';
import {
  adminApi,
  adminSession,
  apiError,
  cachedState,
  deferred,
  page,
  renderApp,
  type ApiHandler,
} from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

const ids = {
  self: adminSession.identity.profileId,
  lijun: '00000000-0000-4000-8000-0000000ad002',
  chen: '00000000-0000-4000-8000-0000000ad003',
  created: '00000000-0000-4000-8000-0000000ad004',
  tenant: '00000000-0000-4000-8000-0000000a0001',
  portal: '00000000-0000-4000-8000-0000000b0001',
  audit: '00000000-0000-4000-8000-0000000c0001',
  otherTenant: '00000000-0000-4000-8000-0000000a0002',
  otherPortal: '00000000-0000-4000-8000-0000000b0002',
};

const admin = (
  id: string,
  name: string,
  email: string,
  status: 'active' | 'disabled' = 'active',
) => ({
  id,
  name,
  email,
  status,
  lastLoginAt: status === 'active' ? '2026-09-28T10:47:05.000Z' : null,
  createdAt: '2026-08-01T00:00:00.000Z',
});

const admins = [
  admin(ids.self, '王敏', 'wangmin@example.com'),
  admin(ids.lijun, '李俊', 'lijun@example.com'),
  admin(ids.chen, '陈静', 'chenjing@example.com', 'disabled'),
];

/** 列表与“启用人数”两个查询共用一个路径，按 status 参数区分。 */
const listAdmins: ApiHandler = (path) =>
  path.includes('status=active')
    ? { status: 200, body: page(admins.slice(0, 1), 2) }
    : { status: 200, body: page(admins) };

async function openAdmins(routes: Record<string, ApiHandler> = {}) {
  const api = adminApi({ 'GET /api/admin/admins': listAdmins, ...routes });
  const app = renderApp('/admin/admins', api.handler);
  const table = await screen.findByRole('table');
  return { ...api, ...app, table, user: userEvent.setup() };
}

const row = (table: HTMLElement, name: string) => {
  const found = within(table)
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(name));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
};

const posts = <Call extends { method: string }>(calls: Call[]) =>
  calls.filter((call) => call.method === 'POST');

describe('admin accounts list', () => {
  it('marks your own row and blocks disabling yourself', async () => {
    const { table } = await openAdmins();
    expect(await screen.findByText('共 3 位 · 2 位启用')).toBeVisible();

    const own = row(table, '王敏');
    expect(within(own).getByText('你')).toBeVisible();
    const selfDisable = within(own).getByRole('button', { name: '停用 王敏' });
    expect(selfDisable).toBeDisabled();
    expect(selfDisable).toHaveAccessibleDescription('不能停用自己的账号');

    expect(within(row(table, '李俊')).queryByText('你')).toBeNull();
    expect(
      within(row(table, '李俊')).getByRole('button', { name: '停用 李俊' }),
    ).toBeEnabled();
    expect(
      within(row(table, '陈静')).getByRole('button', { name: '启用 陈静' }),
    ).toBeEnabled();
    expect(within(row(table, '陈静')).getByText('从未登录')).toBeVisible();
  });

  it('the mobile action sheet greys out disabling yourself', async () => {
    const { user } = await openAdmins();
    await user.click(screen.getByRole('button', { name: '王敏 的操作' }));
    const sheet = screen.getByRole('dialog', { name: '王敏 的操作' });
    expect(within(sheet).getByText('王敏（你）')).toBeVisible();
    expect(within(sheet).getByRole('button', { name: /^停用/ })).toBeDisabled();
    expect(within(sheet).getByText('不能停用自己的账号')).toBeVisible();
    expect(
      within(sheet).getByRole('button', { name: '重置密码' }),
    ).toBeEnabled();
  });
});

describe('create admin', () => {
  const created = admin(ids.created, '赵磊', 'zhaolei@example.com');

  it('shows the temporary password once and keeps it out of the caches', async () => {
    const { user, calls, queryClient } = await openAdmins({
      'POST /api/admin/admins': () => ({
        status: 200,
        body: {
          auditId: ids.audit,
          account: { ...created, lastLoginAt: null },
          temporaryPassword: 'Kx7m-Qp42-Rt9w',
        },
      }),
    });
    await user.click(screen.getByRole('button', { name: '＋ 新增管理员' }));
    const form = screen.getByRole('form', { name: '新增管理员' });
    await user.type(within(form).getByLabelText(/姓名/), ' 赵磊 ');
    await user.type(
      within(form).getByLabelText(/登录邮箱/),
      'zhaolei@example.com',
    );
    await user.click(
      within(form).getByRole('button', { name: '创建并生成临时密码' }),
    );

    const result = await screen.findByRole('dialog', {
      name: '已创建管理员 赵磊',
    });
    expect(
      within(result).getByRole('textbox', { name: '临时密码' }),
    ).toHaveValue('Kx7m-Qp42-Rt9w');
    expect(within(result).getByText('关闭后无法再次查看')).toBeVisible();
    expect(result).toHaveTextContent('对方首次登录后需修改密码');
    expect(posts(calls)).toEqual([
      {
        path: '/api/admin/admins',
        method: 'POST',
        body: { name: '赵磊', email: 'zhaolei@example.com' },
      },
    ]);
    expect(cachedState(queryClient)).not.toContain('Kx7m-Qp42-Rt9w');

    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: '已创建管理员 赵磊' })).toBe(
      result,
    );
    await user.click(
      within(result).getByRole('button', { name: '我已复制，关闭' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText('Kx7m-Qp42-Rt9w')).toBeNull();
    expect(screen.queryByDisplayValue('Kx7m-Qp42-Rt9w')).toBeNull();
  });

  it('checks fields locally without calling the API', async () => {
    const { user, calls } = await openAdmins();
    await user.click(screen.getByRole('button', { name: '＋ 新增管理员' }));
    const form = screen.getByRole('form', { name: '新增管理员' });
    await user.type(within(form).getByLabelText(/登录邮箱/), 'not-an-email');
    await user.click(
      within(form).getByRole('button', { name: '创建并生成临时密码' }),
    );
    expect(within(form).getByText('请输入姓名')).toBeVisible();
    expect(within(form).getByText('邮箱格式不正确')).toBeVisible();
    expect(posts(calls)).toEqual([]);
  });

  it('an existing email is reported on the email field', async () => {
    const { user } = await openAdmins({
      'POST /api/admin/admins': () => ({
        status: 409,
        body: apiError('EMAIL_EXISTS'),
      }),
    });
    await user.click(screen.getByRole('button', { name: '＋ 新增管理员' }));
    const form = screen.getByRole('form', { name: '新增管理员' });
    await user.type(within(form).getByLabelText(/姓名/), '李俊');
    await user.type(
      within(form).getByLabelText(/登录邮箱/),
      'lijun@example.com',
    );
    await user.click(
      within(form).getByRole('button', { name: '创建并生成临时密码' }),
    );
    expect(
      await within(form).findByLabelText(/登录邮箱/),
    ).toHaveAccessibleDescription('该邮箱已被其他账号使用');
  });

  it('a lost response is not retried and points to the list and password reset', async () => {
    const { user, calls } = await openAdmins({
      'POST /api/admin/admins': () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await user.click(screen.getByRole('button', { name: '＋ 新增管理员' }));
    const form = screen.getByRole('form', { name: '新增管理员' });
    await user.type(within(form).getByLabelText(/姓名/), '赵磊');
    await user.type(
      within(form).getByLabelText(/登录邮箱/),
      'zhaolei@example.com',
    );
    await user.click(
      within(form).getByRole('button', { name: '创建并生成临时密码' }),
    );
    const alert = await within(form).findByRole('alert');
    expect(alert).toHaveTextContent('无法确认是否已创建');
    expect(alert).toHaveTextContent('用「重置密码」生成新的临时密码');
    expect(posts(calls)).toHaveLength(1);
  });
});

describe('admin status and reset', () => {
  it('maps LAST_ADMIN to the cannot-disable explanation', async () => {
    const { user, table } = await openAdmins({
      [`POST /api/admin/admins/${ids.lijun}/disable`]: () => ({
        status: 409,
        body: apiError('LAST_ADMIN'),
      }),
    });
    await user.click(
      within(row(table, '李俊')).getByRole('button', { name: '停用 李俊' }),
    );
    const confirm = screen.getByRole('dialog', { name: '停用管理员 李俊？' });
    expect(confirm).toHaveTextContent('停用后李俊会立即退出登录');
    await user.click(within(confirm).getByRole('button', { name: '停用' }));
    const refused = await screen.findByRole('dialog', { name: '无法停用' });
    expect(refused).toHaveTextContent(
      '系统至少需要保留一位启用的管理员。请先新增或启用其他管理员，再执行此操作。',
    );
    await user.click(within(refused).getByRole('button', { name: '知道了' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('maps a server SELF_DISABLE refusal', async () => {
    const { user, table } = await openAdmins({
      [`POST /api/admin/admins/${ids.lijun}/disable`]: () => ({
        status: 409,
        body: apiError('SELF_DISABLE'),
      }),
    });
    await user.click(
      within(row(table, '李俊')).getByRole('button', { name: '停用 李俊' }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '停用' }),
    );
    expect(
      await screen.findByRole('dialog', { name: '无法停用' }),
    ).toHaveTextContent('不能停用自己的账号');
  });

  it('a disable that changed nothing says so', async () => {
    const { user, table } = await openAdmins({
      [`POST /api/admin/admins/${ids.lijun}/disable`]: () => ({
        status: 200,
        body: { auditId: null },
      }),
    });
    await user.click(
      within(row(table, '李俊')).getByRole('button', { name: '停用 李俊' }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '停用' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '李俊 已是停用状态，没有变更',
    );
  });

  it('enabling reports the audited change', async () => {
    const { user, table } = await openAdmins({
      [`POST /api/admin/admins/${ids.chen}/enable`]: () => ({
        status: 200,
        body: { auditId: ids.audit },
      }),
    });
    await user.click(
      within(row(table, '陈静')).getByRole('button', { name: '启用 陈静' }),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: '启用' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '已启用管理员 陈静，已记入操作日志',
    );
  });

  it('reset shows the new temporary password once', async () => {
    const { user, table, queryClient } = await openAdmins({
      [`POST /api/admin/admins/${ids.lijun}/reset-password`]: () => ({
        status: 200,
        body: { temporaryPassword: 'Hn4t-Wz83-Lc6p' },
      }),
    });
    await user.click(
      within(row(table, '李俊')).getByRole('button', {
        name: '重置 李俊 的密码',
      }),
    );
    const confirm = screen.getByRole('dialog', { name: '重置 李俊 的密码？' });
    await user.click(within(confirm).getByRole('button', { name: '重置密码' }));
    const result = await screen.findByRole('dialog', {
      name: '已为 李俊 生成临时密码',
    });
    expect(
      within(result).getByRole('textbox', { name: '临时密码' }),
    ).toHaveValue('Hn4t-Wz83-Lc6p');
    expect(result).toHaveTextContent('原密码已失效，李俊的所有登录已退出');
    expect(result).toHaveTextContent('对方首次登录后需修改密码');
    expect(cachedState(queryClient)).not.toContain('Hn4t-Wz83-Lc6p');
    await user.click(
      within(result).getByRole('button', { name: '我已复制，关闭' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByDisplayValue('Hn4t-Wz83-Lc6p')).toBeNull();
  });
});

const tenant = (status: 'active' | 'disabled') => ({
  id: ids.tenant,
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
  status,
  health: status === 'active' ? 'normal' : 'disabled',
  settingsConfigured: true,
  balance: '100',
  overdraftLimit: '0',
  availableBalance: '100',
  monthConsumption: '0',
  pendingReceivable: '0',
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: { overdraftLimit: '0', lowBalanceThreshold: '10', emails: [] },
  createdAt: '2026-08-12T02:31:02.000Z',
});

const portalAccount = (status: 'active' | 'disabled') => ({
  id: ids.portal,
  email: 'billing@abc-tech.cn',
  status,
  lastLoginAt: null,
  createdAt: '2026-08-12T02:31:02.000Z',
});

async function openPortal(
  routes: Record<string, ApiHandler>,
  tenantStatus: 'active' | 'disabled' = 'active',
) {
  const api = adminApi({
    [`GET /api/admin/tenants/${ids.tenant}`]: () => ({
      status: 200,
      body: tenant(tenantStatus),
    }),
    ...routes,
  });
  const app = renderApp(`/admin/tenants/${ids.tenant}?tab=portal`, api.handler);
  await screen.findByRole('region', { name: '客户门户账号' });
  return { ...api, ...app, user: userEvent.setup() };
}

describe('portal account tab', () => {
  it('opens a missing portal account with a generated password shown once', async () => {
    let account: ReturnType<typeof portalAccount> | null = null;
    const { user, calls, queryClient } = await openPortal({
      [`GET /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => ({
        status: 200,
        body: { items: account ? [account] : [] },
      }),
      [`POST /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => {
        account = portalAccount('active');
        return {
          status: 200,
          body: {
            auditId: ids.audit,
            account,
            passwordSource: 'generated',
            temporaryPassword: 'Pq8z-Lm31-Xc7v',
          },
        };
      },
    });
    await user.click(
      await screen.findByRole('button', { name: '开通门户账号' }),
    );
    const form = screen.getByRole('form', { name: '开通门户账号' });
    await user.type(
      within(form).getByLabelText(/登录邮箱/),
      'billing@abc-tech.cn',
    );
    await user.click(within(form).getByRole('button', { name: '开通' }));
    const result = await screen.findByRole('dialog', {
      name: '门户账号已开通',
    });
    expect(
      within(result).getByRole('textbox', { name: '临时密码' }),
    ).toHaveValue('Pq8z-Lm31-Xc7v');
    expect(posts(calls)).toEqual([
      {
        path: `/api/admin/tenants/${ids.tenant}/portal-accounts`,
        method: 'POST',
        body: { email: 'billing@abc-tech.cn' },
      },
    ]);
    expect(cachedState(queryClient)).not.toContain('Pq8z-Lm31-Xc7v');
    await user.click(
      within(result).getByRole('button', { name: '我已复制，关闭' }),
    );
    expect(await screen.findByText('billing@abc-tech.cn')).toBeVisible();
  });

  it('a supplied initial password is sent but never echoed', async () => {
    const { user, calls, queryClient } = await openPortal({
      [`GET /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => ({
        status: 200,
        body: { items: [] },
      }),
      [`POST /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => ({
        status: 200,
        body: {
          auditId: ids.audit,
          account: portalAccount('active'),
          passwordSource: 'supplied',
        },
      }),
    });
    await user.click(
      await screen.findByRole('button', { name: '开通门户账号' }),
    );
    const form = screen.getByRole('form', { name: '开通门户账号' });
    await user.type(
      within(form).getByLabelText(/登录邮箱/),
      'billing@abc-tech.cn',
    );
    await user.type(within(form).getByLabelText(/初始密码/), 'Abc12345!');
    await user.click(within(form).getByRole('button', { name: '开通' }));
    const result = await screen.findByRole('dialog', {
      name: '门户账号已开通',
    });
    expect(result).toHaveTextContent('使用填写的初始密码');
    expect(within(result).queryByRole('textbox')).toBeNull();
    expect(posts(calls)[0]?.body).toEqual({
      email: 'billing@abc-tech.cn',
      initialPassword: 'Abc12345!',
    });
    expect(cachedState(queryClient)).not.toContain('Abc12345!');
  });

  it('disabling explains calls are not affected; reset shows a one-time password', async () => {
    const { user } = await openPortal({
      [`GET /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => ({
        status: 200,
        body: { items: [portalAccount('active')] },
      }),
      [`POST /api/admin/portal-accounts/${ids.portal}/disable`]: () => ({
        status: 200,
        body: { auditId: ids.audit },
      }),
      [`POST /api/admin/portal-accounts/${ids.portal}/reset-password`]: () => ({
        status: 200,
        body: { temporaryPassword: 'Hn4t-Wz83-Lc6p' },
      }),
    });
    const section = screen.getByRole('region', { name: '客户门户账号' });
    await user.click(within(section).getByRole('button', { name: '停用账号' }));
    const confirm = screen.getByRole('dialog', { name: '停用门户账号？' });
    expect(confirm).toHaveTextContent('不影响呼叫和计费');
    expect(confirm).toHaveTextContent('租户的呼叫、计费和余额不受影响');
    await user.click(within(confirm).getByRole('button', { name: '停用账号' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '门户账号已停用，已记入操作日志',
    );

    await user.click(within(section).getByRole('button', { name: '重置密码' }));
    await user.click(
      within(
        screen.getByRole('dialog', { name: '重置门户账号密码？' }),
      ).getByRole('button', { name: '重置密码' }),
    );
    const result = await screen.findByRole('dialog', {
      name: '已生成临时密码',
    });
    expect(
      within(result).getByRole('textbox', { name: '临时密码' }),
    ).toHaveValue('Hn4t-Wz83-Lc6p');
    expect(result).toHaveTextContent('客户首次登录后需修改密码');
  });

  it('enabling on a disabled tenant says the tenant stays disabled', async () => {
    const { user } = await openPortal(
      {
        [`GET /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => ({
          status: 200,
          body: { items: [portalAccount('disabled')] },
        }),
      },
      'disabled',
    );
    const section = screen.getByRole('region', { name: '客户门户账号' });
    await user.click(
      await within(section).findByRole('button', { name: '启用账号' }),
    );
    expect(
      screen.getByRole('dialog', { name: '启用门户账号？' }),
    ).toHaveTextContent('启用门户账号不会启用租户');
  });
});

describe('portal dialogs across cached tenants', () => {
  type Reply = { status: number; body: unknown };
  const other = {
    ...tenant('active'),
    id: ids.otherTenant,
    code: 'XYZ002',
    name: '另一家租户',
  };

  /** 两个租户的详情与门户账号都已缓存后回到租户 A 的门户账号页。 */
  async function openBoth(
    accounts: Record<string, unknown[]>,
    routes: Record<string, ApiHandler>,
  ) {
    const opened = await openPortal({
      [`GET /api/admin/tenants/${ids.tenant}/portal-accounts`]: () => ({
        status: 200,
        body: { items: accounts[ids.tenant] },
      }),
      [`GET /api/admin/tenants/${ids.otherTenant}`]: () => ({
        status: 200,
        body: other,
      }),
      [`GET /api/admin/tenants/${ids.otherTenant}/portal-accounts`]: () => ({
        status: 200,
        body: { items: accounts[ids.otherTenant] },
      }),
      ...routes,
    });
    const visit = async (tenantId: string, heading: string) => {
      await opened.router.navigate({
        to: '/admin/tenants/$tenantId',
        params: { tenantId },
        search: { tab: 'portal' },
      });
      await screen.findByRole('heading', { name: heading });
      return screen.findByRole('region', { name: '客户门户账号' });
    };
    await visit(ids.otherTenant, '另一家租户');
    const section = await visit(ids.tenant, '深圳市某某科技有限公司');
    return { ...opened, section, visit };
  }

  it('a delayed create response for tenant A never shows under tenant B', async () => {
    const response = deferred<Reply>();
    const { user, visit } = await openBoth(
      { [ids.tenant]: [], [ids.otherTenant]: [] },
      {
        [`POST /api/admin/tenants/${ids.tenant}/portal-accounts`]: () =>
          response.promise,
      },
    );
    await user.click(
      await screen.findByRole('button', { name: '开通门户账号' }),
    );
    const form = screen.getByRole('form', { name: '开通门户账号' });
    await user.type(
      within(form).getByLabelText(/登录邮箱/),
      'billing@abc-tech.cn',
    );
    await user.click(within(form).getByRole('button', { name: '开通' }));
    expect(
      within(form).getByRole('button', { name: '正在开通…' }),
    ).toBeDisabled();

    await visit(ids.otherTenant, '另一家租户');
    expect(screen.queryByRole('dialog')).toBeNull();
    response.resolve({
      status: 200,
      body: {
        auditId: ids.audit,
        account: portalAccount('active'),
        passwordSource: 'generated',
        temporaryPassword: 'Pq8z-Lm31-Xc7v',
      },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '开通门户账号' }),
      ).toBeVisible(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByDisplayValue('Pq8z-Lm31-Xc7v')).toBeNull();
  });

  it('a delayed reset response for tenant A never shows under tenant B', async () => {
    const response = deferred<Reply>();
    const { user, section, visit } = await openBoth(
      {
        [ids.tenant]: [portalAccount('active')],
        [ids.otherTenant]: [
          {
            ...portalAccount('active'),
            id: ids.otherPortal,
            email: 'ops@xyz.cn',
          },
        ],
      },
      {
        [`POST /api/admin/portal-accounts/${ids.portal}/reset-password`]: () =>
          response.promise,
      },
    );
    await user.click(
      await within(section).findByRole('button', { name: '重置密码' }),
    );
    const confirm = screen.getByRole('dialog', { name: '重置门户账号密码？' });
    await user.click(within(confirm).getByRole('button', { name: '重置密码' }));
    expect(
      within(confirm).getByRole('button', { name: '正在重置…' }),
    ).toBeDisabled();

    await visit(ids.otherTenant, '另一家租户');
    expect(await screen.findByText('ops@xyz.cn')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    response.resolve({
      status: 200,
      body: { temporaryPassword: 'Hn4t-Wz83-Lc6p' },
    });
    await new Promise((settle) => setTimeout(settle, 20));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByDisplayValue('Hn4t-Wz83-Lc6p')).toBeNull();
  });
});

describe('account dialogs return focus to the opener', () => {
  it('after cancelling and after acknowledging a temporary password', async () => {
    const { user, table } = await openAdmins({
      [`POST /api/admin/admins/${ids.lijun}/reset-password`]: () => ({
        status: 200,
        body: { temporaryPassword: 'Hn4t-Wz83-Lc6p' },
      }),
    });
    const opener = within(row(table, '李俊')).getByRole('button', {
      name: '重置 李俊 的密码',
    });
    await user.click(opener);
    await user.click(
      within(
        screen.getByRole('dialog', { name: '重置 李俊 的密码？' }),
      ).getByRole('button', { name: '取消' }),
    );
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await user.click(
      within(
        screen.getByRole('dialog', { name: '重置 李俊 的密码？' }),
      ).getByRole('button', { name: '重置密码' }),
    );
    const result = await screen.findByRole('dialog', {
      name: '已为 李俊 生成临时密码',
    });
    await user.click(
      within(result).getByRole('button', { name: '我已复制，关闭' }),
    );
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('escape from the create dialog returns to the create button', async () => {
    const { user } = await openAdmins();
    const opener = screen.getByRole('button', { name: '＋ 新增管理员' });
    await user.click(opener);
    expect(screen.getByRole('form', { name: '新增管理员' })).toBeVisible();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('a dialog opened from the mobile action sheet returns to the sheet opener', async () => {
    const { user } = await openAdmins();
    const opener = screen.getByRole('button', { name: '李俊 的操作' });
    await user.click(opener);
    await user.click(
      within(screen.getByRole('dialog', { name: '李俊 的操作' })).getByRole(
        'button',
        { name: '重置密码' },
      ),
    );
    await user.click(
      within(
        screen.getByRole('dialog', { name: '重置 李俊 的密码？' }),
      ).getByRole('button', { name: '取消' }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
