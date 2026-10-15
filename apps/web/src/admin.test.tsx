import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordGate, sessionExpiry } from './lib/session';
import {
  adminSession,
  apiError,
  customerSession,
  renderApp,
  type ApiHandler,
} from './test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

const tenantIds = {
  abc: '00000000-0000-4000-8000-00000000a001',
  glb: '00000000-0000-4000-8000-00000000a002',
  old: '00000000-0000-4000-8000-00000000a003',
  created: '00000000-0000-4000-8000-00000000a004',
};

function summary(overrides: Record<string, unknown>) {
  return {
    id: tenantIds.abc,
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
    ...overrides,
  };
}

const tenants = [
  summary({}),
  summary({
    id: tenantIds.glb,
    code: 'GLB009',
    name: 'Global Voice Partners',
    currency: 'USD',
    health: 'suspended',
    balance: '-15.02',
    overdraftLimit: '15',
    availableBalance: '-0.02',
    monthConsumption: '274.9',
    pendingReceivable: '0',
  }),
  summary({
    id: tenantIds.old,
    code: 'OLD001',
    name: '存量租户',
    health: 'normal',
    settingsConfigured: false,
    balance: '10',
    pendingReceivable: '0',
  }),
];

const page = (items: unknown[], total = items.length) => ({
  items,
  pagination: { page: 1, pageSize: 25, total },
});

type Call = { path: string; method: string; body: unknown };

/** 记录请求并按 “METHOD 路径” 前缀应答；会话默认是管理员。 */
function adminApi(
  routes: Record<string, ApiHandler>,
  session: object = adminSession,
) {
  const calls: Call[] = [];
  const handler: ApiHandler = (path, init) => {
    const method = init.method ?? 'GET';
    calls.push({
      path,
      method,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (path === '/api/auth/session') return { status: 200, body: session };
    const pathname = path.split('?')[0];
    const route = routes[`${method} ${pathname}`];
    if (!route) throw new Error(`unexpected ${method} ${path}`);
    return route(path, init);
  };
  return { calls, handler };
}

describe('password change gate', () => {
  function gateApi() {
    let required = true;
    const calls: string[] = [];
    const handler: ApiHandler = (path, init) => {
      calls.push(`${init.method ?? 'GET'} ${path}`);
      if (path === '/api/auth/session')
        return {
          status: 200,
          body: { ...adminSession, passwordChangeRequired: required },
        };
      if (path === '/api/auth/change-password') {
        const body = JSON.parse(init.body as string) as {
          currentPassword: string;
        };
        if (body.currentPassword !== 'Temp-Pass-2026')
          return { status: 401, body: apiError('INVALID_CREDENTIALS') };
        required = false;
        return { status: 200, body: adminSession };
      }
      if (path.startsWith('/api/admin/tenants?'))
        return required
          ? { status: 403, body: apiError('PASSWORD_CHANGE_REQUIRED') }
          : { status: 200, body: page(tenants) };
      throw new Error(`unexpected ${path}`);
    };
    return { calls, handler, unlock: () => (required = false) };
  }

  async function fill(current: string, next: string, confirm = next) {
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText('当前密码'), current);
    await user.type(screen.getByLabelText('新密码'), next);
    await user.type(screen.getByLabelText('确认新密码'), confirm);
    await user.click(screen.getByRole('button', { name: '修改密码' }));
  }

  it('forced change makes no business request and returns to the requested page after success', async () => {
    const { calls, handler } = gateApi();
    const { location } = renderApp('/admin/tenants?status=suspended', handler);
    await waitFor(() => expect(location()).toBe('/admin/change-password'));
    expect(new Set(calls)).toEqual(new Set(['GET /api/auth/session']));

    await fill('wrong-temp', 'New-Pass-2026');
    expect(await screen.findByText('当前密码不正确')).toBeVisible();

    await userEvent.clear(screen.getByLabelText('当前密码'));
    await userEvent.type(screen.getByLabelText('当前密码'), 'Temp-Pass-2026');
    await userEvent.click(screen.getByRole('button', { name: '修改密码' }));
    await waitFor(() =>
      expect(location()).toBe('/admin/tenants?status=suspended'),
    );
    expect(await screen.findByRole('heading', { name: '租户' })).toBeVisible();
  });

  it('checks length and confirmation locally before calling the server', async () => {
    const { calls, handler } = gateApi();
    renderApp('/admin/change-password', handler);
    await fill('Temp-Pass-2026', 'short');
    expect(await screen.findByText('新密码至少 8 位')).toBeVisible();
    await userEvent.clear(screen.getByLabelText('新密码'));
    await userEvent.type(screen.getByLabelText('新密码'), 'New-Pass-2026');
    await userEvent.click(screen.getByRole('button', { name: '修改密码' }));
    expect(await screen.findByText('两次输入的新密码不一致')).toBeVisible();
    expect(calls.filter((call) => call.includes('change-password'))).toEqual(
      [],
    );
  });

  it('a 403 PASSWORD_CHANGE_REQUIRED from a page request sends the user to the change screen', async () => {
    let required = false;
    const handler: ApiHandler = (path) => {
      if (path === '/api/auth/session')
        return {
          status: 200,
          body: { ...adminSession, passwordChangeRequired: required },
        };
      if (path.startsWith('/api/admin/tenants?')) {
        // 管理员在别处被重置了密码：会话仍有效，业务请求开始被拒绝。
        required = true;
        return { status: 403, body: apiError('PASSWORD_CHANGE_REQUIRED') };
      }
      throw new Error(`unexpected ${path}`);
    };
    const { location } = renderApp('/admin/tenants', handler);
    await waitFor(() => expect(location()).toBe('/admin/change-password'));
    expect(
      await screen.findByRole('heading', { name: '请修改初始密码' }),
    ).toBeVisible();
    expect(screen.queryByText('租户列表加载失败')).toBeNull();
  });

  it('portal accounts are gated the same way', async () => {
    const { location } = renderApp('/', (path) => {
      if (path === '/api/auth/session')
        return {
          status: 200,
          body: { ...customerSession, passwordChangeRequired: true },
        };
      throw new Error(`unexpected ${path}`);
    });
    await waitFor(() => expect(location()).toBe('/change-password'));
    expect(
      await screen.findByRole('heading', { name: '请修改初始密码' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: '退出登录' })).toBeVisible();
  });
});

describe('admin navigation', () => {
  it('lists the phase 5 admin pages and marks the current one', async () => {
    const { handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page(tenants) }),
    });
    renderApp('/admin/tenants', handler);
    const nav = (
      await screen.findAllByRole('navigation', { name: '主导航' })
    )[0]!;
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => [link.textContent, link.getAttribute('href')]),
    ).toEqual([
      ['概览', '/admin'],
      ['租户', '/admin/tenants'],
      ['待收款', '/admin/receivables'],
      ['管理员', '/admin/admins'],
    ]);
    expect(within(nav).getByRole('link', { name: '租户' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('tenant list', () => {
  it('shows status tags, per-currency amounts and marks tenants without alert settings', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page(tenants) }),
    });
    renderApp('/admin/tenants', handler);
    const table = await screen.findByRole('table');
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) =>
        within(row)
          .getAllByRole('cell')
          .slice(0, 8)
          .map((cell) => cell.textContent),
      );
    expect(rows).toEqual([
      [
        'ABC001',
        '深圳市某某科技有限公司',
        'CNY',
        '透支中',
        '-¥35.20',
        '¥100.00',
        '¥2,486.30',
        '¥500.00',
      ],
      [
        'GLB009',
        'Global Voice Partners',
        'USD',
        '已停机',
        '-$15.02',
        '$15.00',
        '$274.90',
        '—',
      ],
      [
        'OLD001',
        '存量租户',
        'CNY',
        '正常未配置提醒设置',
        '¥10.00',
        '¥100.00',
        '¥2,486.30',
        '—',
      ],
    ]);
    expect(screen.getByText('共 3 个')).toBeVisible();
    expect(calls[1]?.path).toBe(
      '/api/admin/tenants?page=1&pageSize=25&sort=status_currency_balance',
    );
  });

  it('filters go to the API and the URL, and an empty result offers to clear them', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/tenants': (path) => ({
        status: 200,
        body: path.includes('search=') ? page([]) : page(tenants),
      }),
    });
    const { location } = renderApp('/admin/tenants', handler);
    await screen.findByRole('table');
    await userEvent.selectOptions(screen.getByLabelText('状态'), 'suspended');
    await userEvent.click(screen.getByRole('button', { name: 'USD' }));
    await userEvent.type(screen.getByLabelText('搜索编码或名称'), 'ABC01');
    expect(
      await screen.findByText('没有符合条件的租户', undefined, {
        timeout: 2000,
      }),
    ).toBeVisible();
    expect(
      screen.getByText('搜索「ABC01」 · 状态：已停机 · 币种：USD'),
    ).toBeVisible();
    expect(calls.at(-1)?.path).toBe(
      '/api/admin/tenants?page=1&pageSize=25&search=ABC01&status=suspended&currency=USD&sort=status_currency_balance',
    );
    expect(location()).toBe(
      '/admin/tenants?status=suspended&currency=USD&search=ABC01',
    );

    await userEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    await waitFor(() => expect(location()).toBe('/admin/tenants'));
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('with no tenants at all shows the onboarding empty state', async () => {
    const { handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page([]) }),
    });
    renderApp('/admin/tenants', handler);
    expect(await screen.findByText('还没有租户')).toBeVisible();
    expect(
      screen.getByText('新建租户后，在 FreeSWITCH 中设置相同的 billing_tenant'),
    ).toBeVisible();
  });

  it.each([
    [500, 'INTERNAL_ERROR'],
    [503, 'SERVICE_UNAVAILABLE'],
  ])(
    'a %i %s shows the generic unavailable error with retry',
    async (status, code) => {
      let attempts = 0;
      const { handler } = adminApi({
        'GET /api/admin/tenants': () => {
          attempts += 1;
          return attempts <= 3
            ? { status, body: apiError(code) }
            : { status: 200, body: page(tenants) };
        },
      });
      renderApp('/admin/tenants', handler);
      const alert = await screen.findByRole('alert', undefined, {
        timeout: 5000,
      });
      expect(alert).toHaveTextContent(
        '租户列表加载失败服务暂时不可用，请稍后重试',
      );
      await userEvent.click(
        within(alert).getByRole('button', { name: '重试' }),
      );
      expect(await screen.findByRole('table')).toBeVisible();
    },
    10_000,
  );

  it('pages through results', async () => {
    const { calls, handler } = adminApi({
      'GET /api/admin/tenants': () => ({
        status: 200,
        body: page(tenants, 60),
      }),
    });
    const { location } = renderApp('/admin/tenants', handler);
    const pager = await screen.findByRole('navigation', { name: '分页' });
    expect(pager).toHaveTextContent('第 1 / 3 页');
    await userEvent.click(
      within(pager).getByRole('button', { name: '下一页' }),
    );
    await waitFor(() => expect(location()).toBe('/admin/tenants?page=2'));
    expect(calls.at(-1)?.path).toContain('page=2&');
  });
});

describe('tenant detail', () => {
  it('a tenant without alert settings explains the detail error instead of a blank page', async () => {
    const { handler } = adminApi({
      'GET /api/admin/tenants': () => ({ status: 200, body: page(tenants) }),
      [`GET /api/admin/tenants/${tenantIds.old}`]: () => ({
        status: 500,
        body: apiError('INTERNAL_ERROR'),
      }),
    });
    renderApp('/admin/tenants', handler);
    await userEvent.click(await screen.findByRole('link', { name: 'OLD001' }));
    expect(
      await screen.findByText(
        '该租户缺少余额提醒设置，暂时无法查看详情',
        undefined,
        {
          timeout: 5000,
        },
      ),
    ).toBeVisible();
  }, 10_000);
});

describe('tenant create', () => {
  const createdTenant = {
    ...summary({
      id: tenantIds.created,
      code: 'PCL022',
      name: 'Pacific Link Communications Ltd',
      currency: 'USD',
      health: 'suspended',
      balance: '0',
      overdraftLimit: '15',
      availableBalance: '15',
      monthConsumption: '0',
      pendingReceivable: '0',
    }),
    contactName: '',
    contactPhone: '',
    remark: '',
    settings: {
      overdraftLimit: '15',
      lowBalanceThreshold: '30',
      emails: ['wangmin@example.com'],
    },
    createdAt: '2026-10-15T02:00:00.000Z',
  };
  const createResponse = {
    auditId: '00000000-0000-4000-8000-00000000b001',
    tenant: createdTenant,
    initialRateVersionId: '00000000-0000-4000-8000-00000000b002',
    effectiveFrom: '2026-10-15T02:00:00.000Z',
  };
  const portalAccount = {
    id: '00000000-0000-4000-8000-00000000b003',
    email: 'billing@pacificlink.sg',
    status: 'active',
    lastLoginAt: null,
    createdAt: '2026-10-15T02:00:01.000Z',
  };

  async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
    await user.type(await screen.findByLabelText(/租户编码/), 'pcl022');
    await user.type(
      screen.getByLabelText(/租户名称/),
      'Pacific Link Communications Ltd',
    );
    await user.click(screen.getByRole('radio', { name: 'USD 美元' }));
    await user.type(screen.getByLabelText(/余额提醒阈值/), '30');
    await user.type(
      screen.getByLabelText(/登录邮箱/),
      'billing@pacificlink.sg',
    );
  }

  it('creates the tenant, then the portal account, and shows the generated password once', async () => {
    const { calls, handler } = adminApi({
      'POST /api/admin/tenants': () => ({ status: 200, body: createResponse }),
      [`POST /api/admin/tenants/${tenantIds.created}/portal-accounts`]: () => ({
        status: 200,
        body: {
          auditId: '00000000-0000-4000-8000-00000000b004',
          account: portalAccount,
          passwordSource: 'generated',
          temporaryPassword: 'Kp7#vR2mQx9s',
        },
      }),
      [`GET /api/admin/tenants/${tenantIds.created}`]: () => ({
        status: 200,
        body: createdTenant,
      }),
    });
    const { location } = renderApp('/admin/tenants/new', handler);
    const user = userEvent.setup();
    await fillRequired(user);
    expect(screen.getByText(/将保存为大写 PCL022/)).toBeVisible();
    expect(screen.getByLabelText(/透支额度/)).toHaveValue('15.00');
    expect(screen.getByRole('listitem')).toHaveTextContent(
      'wangmin@example.com',
    );
    await user.click(screen.getByRole('button', { name: '创建租户' }));

    const dialog = await screen.findByRole('dialog', {
      name: '租户 PCL022 已创建',
    });
    expect(
      within(dialog).getByRole('textbox', { name: 'FreeSWITCH 通道变量' }),
    ).toHaveValue('billing_tenant=PCL022');
    expect(
      within(dialog).getByRole('button', { name: '复制 FreeSWITCH 通道变量' }),
    ).toBeVisible();
    expect(
      await within(dialog).findByRole('textbox', { name: '临时密码' }),
    ).toHaveValue('Kp7#vR2mQx9s');
    expect(
      within(dialog).getByRole('button', { name: '复制 临时密码' }),
    ).toBeVisible();
    expect(
      within(dialog).getByText('只显示一次，关闭后无法再次查看'),
    ).toBeVisible();

    const writes = calls.filter((call) => call.method === 'POST');
    expect(writes).toEqual([
      {
        path: '/api/admin/tenants',
        method: 'POST',
        body: {
          code: 'PCL022',
          name: 'Pacific Link Communications Ltd',
          currency: 'USD',
          contactName: '',
          contactPhone: '',
          remark: '',
          settings: {
            overdraftLimit: '15.00',
            lowBalanceThreshold: '30',
            emails: ['wangmin@example.com'],
          },
          initialRates: { kind: 'blank' },
        },
      },
      {
        path: `/api/admin/tenants/${tenantIds.created}/portal-accounts`,
        method: 'POST',
        body: { email: 'billing@pacificlink.sg' },
      },
    ]);

    await user.click(within(dialog).getByRole('button', { name: '查看租户' }));
    await waitFor(() =>
      expect(location()).toBe(`/admin/tenants/${tenantIds.created}`),
    );
    expect(screen.queryByText('Kp7#vR2mQx9s')).toBeNull();
  });

  it('keeps the created tenant when the portal account fails and allows a retry', async () => {
    let portalAttempts = 0;
    const { handler } = adminApi({
      'POST /api/admin/tenants': () => ({ status: 200, body: createResponse }),
      [`POST /api/admin/tenants/${tenantIds.created}/portal-accounts`]: () => {
        portalAttempts += 1;
        return portalAttempts === 1
          ? { status: 409, body: apiError('EMAIL_EXISTS') }
          : {
              status: 200,
              body: {
                auditId: '00000000-0000-4000-8000-00000000b004',
                account: portalAccount,
                passwordSource: 'supplied',
              },
            };
      },
    });
    renderApp('/admin/tenants/new', handler);
    const user = userEvent.setup();
    await fillRequired(user);
    await user.type(screen.getByLabelText(/初始密码/), 'Supplied-2026');
    await user.click(screen.getByRole('button', { name: '创建租户' }));
    const dialog = await screen.findByRole('dialog', {
      name: '租户 PCL022 已创建',
    });
    const failure = await within(dialog).findByRole('alert');
    expect(failure).toHaveTextContent('门户账号 billing@pacificlink.sg 未开通');
    expect(failure).toHaveTextContent('该邮箱已被其他账号使用');
    await user.click(within(failure).getByRole('button', { name: '重试开通' }));
    expect(
      await within(dialog).findByText(
        '使用填写的初始密码，客户首次登录后需修改密码。',
      ),
    ).toBeVisible();
    expect(
      within(dialog).queryByRole('textbox', { name: '临时密码' }),
    ).toBeNull();
  });

  it('shows every local error at once without calling the API', async () => {
    const { calls, handler } = adminApi({});
    renderApp('/admin/tenants/new', handler);
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/租户编码/), 'ABC 01!');
    await user.type(screen.getByLabelText(/登录邮箱/), 'finance@abc');
    await user.click(screen.getByRole('button', { name: '创建租户' }));
    expect(await screen.findByText('有 4 处需要修改')).toBeVisible();
    expect(
      screen.getByText('只能包含字母和数字，不能有空格或符号'),
    ).toBeVisible();
    expect(screen.getByText('请输入租户名称')).toBeVisible();
    expect(screen.getByText('请输入余额提醒阈值')).toBeVisible();
    expect(screen.getByText('邮箱格式不正确')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText(/租户编码/)).toHaveFocus(),
    );
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/session']);
  });

  it('maps an existing code to the code field', async () => {
    const { handler } = adminApi({
      'POST /api/admin/tenants': () => ({
        status: 409,
        body: apiError('TENANT_CODE_EXISTS'),
      }),
    });
    renderApp('/admin/tenants/new', handler);
    const user = userEvent.setup();
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: '创建租户' }));
    expect(await screen.findByText('租户编码已被使用')).toBeVisible();
    expect(screen.getByText('编码 PCL022 已存在，请换一个')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('warns that alerts cannot be delivered when every recipient is removed', async () => {
    const { handler } = adminApi({});
    renderApp('/admin/tenants/new', handler);
    expect(screen.queryByText('未配置收件人，余额提醒无法送达')).toBeNull();
    await userEvent.click(
      await screen.findByRole('button', { name: '移除 wangmin@example.com' }),
    );
    expect(screen.getByText('未配置收件人，余额提醒无法送达')).toBeVisible();
  });

  it('lists every CSV row error and does not create the tenant', async () => {
    const { handler } = adminApi({
      'POST /api/admin/tenants': () => ({
        status: 400,
        body: apiError('CSV_INVALID', {
          rows: [
            { line: 12, reason: '前缀只能包含数字' },
            { line: 37, reason: '费率不能为负数' },
          ],
        }),
      }),
    });
    renderApp('/admin/tenants/new', handler);
    const user = userEvent.setup();
    await fillRequired(user);
    await user.click(screen.getByRole('radio', { name: /从 CSV 导入/ }));
    await user.upload(
      screen.getByLabelText('CSV 文件'),
      new File(['prefix,country,rate\n44-7,英国手机,0.0480\n'], 'rates.csv', {
        type: 'text/csv',
      }),
    );
    expect(await screen.findByText('已选择 rates.csv')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '创建租户' }));
    const rows = await screen.findByText('CSV 有 2 行错误，租户未创建');
    expect(rows.parentElement).toHaveTextContent(
      '第 12 行：前缀只能包含数字第 37 行：费率不能为负数',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
