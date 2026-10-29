import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { passwordGate, sessionExpiry } from '../../lib/session';
import { adminApi, apiError, renderApp, type ApiHandler } from '../../test/app';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
  passwordGate.clear();
});

/** 「提示」警示条：文字、行内编码和后续文字是同一个说明的内容，不是 Alert 的并列子元素（会各占一行）。 */
function expectBillingTenantHint() {
  const code = screen.getByText('billing_tenant');
  const description = code.closest('[data-slot="alert-description"]');
  expect(description).not.toBeNull();
  expect(description?.parentElement).toHaveAttribute('data-slot', 'alert');
  expect(description?.parentElement?.children).toHaveLength(1);
  expect(description).toHaveTextContent(
    '提示 请同时检查 FreeSWITCH 中的 billing_tenant 配置，否则新话单会继续进入此处。',
  );
}

const tenantId = '00000000-0000-4000-8000-00000000a001';
const auditId = '00000000-0000-4000-8000-00000000c001';
const assignmentId = '00000000-0000-4000-8000-00000000c002';

function id(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

const tenant = {
  id: tenantId,
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY' as const,
  status: 'active',
  health: 'overdraft',
  settingsConfigured: true,
  balance: '-35.20',
  overdraftLimit: '100',
  availableBalance: '64.80',
  monthConsumption: '0',
  pendingReceivable: '0',
};

function cdr(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: id(n),
    callUuid: id(n),
    time: '2026-08-04T16:00:00.000Z',
    receivedAt: '2026-08-04T16:05:00.000Z',
    tag: 'ABC01',
    caller: `1380000${String(n).padStart(4, '0')}`,
    callee: `1876000${String(n).padStart(4, '0')}`,
    durationSeconds: 230,
    reason: '租户不存在',
    assignable: true,
    pushCount: 1,
    ignore: null,
    ...overrides,
  };
}

const pendingRows = [
  cdr(1),
  cdr(2, {
    callUuid: null,
    time: null,
    receivedAt: '2026-08-05T01:02:03.000Z',
    tag: '',
    caller: '10086',
    callee: '10010',
    reason: '校验失败',
    assignable: false,
  }),
];

const ignoredRow = cdr(9, {
  tag: 'TEST',
  caller: '02100000009',
  callee: '10000',
  reason: '测试呼叫',
  assignable: false,
  ignore: {
    reason: '测试呼叫，不属于任何客户',
    by: { id: '00000000-0000-4000-8000-000000000009', name: '王敏' },
    at: '2026-10-01T02:00:00.000Z',
  },
});

const groups = {
  total: 338,
  groups: [
    {
      tag: 'ABC01',
      count: 326,
      reasons: [
        { reason: '租户不存在', count: 324 },
        { reason: '接通时无费率', count: 2 },
      ],
      suggestedTenants: [
        { id: tenantId, code: 'ABC001', name: '深圳市某某科技有限公司' },
      ],
    },
    {
      tag: '',
      count: 12,
      reasons: [{ reason: '缺少租户标签', count: 12 }],
      suggestedTenants: [],
    },
  ],
};

function listed(
  status: 'pending' | 'ignored',
  items: unknown[],
  total = items.length,
) {
  return {
    status,
    items,
    pagination: { page: 1, pageSize: 50, total },
  };
}

function previewBody(overrides: Record<string, unknown> = {}) {
  return {
    tenant: {
      id: tenantId,
      code: 'ABC001',
      name: '深圳市某某科技有限公司',
      currency: 'CNY',
    },
    selected: 326,
    assignable: 324,
    chargeTotal: '58.35',
    currency: 'CNY',
    noRate: {
      count: 2,
      groups: [
        {
          reason: 'before_first_version',
          // 决定 36：接通早于第一个费率版本时不提前缀，即使服务端带了 prefixHint。
          prefixHint: { prefix: '1876', country: '牙买加' },
          count: 2,
          firstEffectiveFrom: '2026-08-12T01:30:00.000Z',
          samples: [
            {
              id: id(1),
              answeredAt: '2026-08-04T16:00:00.000Z',
              billingNumber: '18761234567',
            },
          ],
        },
      ],
    },
    blocked: { count: 0, months: [] },
    notAssignable: { count: 0, reasons: [] },
    balance: { current: '-35.20', afterEstimate: '-93.55' },
    affectedMonths: [
      { month: '2026-09', statementState: 'final' },
      { month: '2026-10', statementState: 'live' },
      { month: '2026-08', statementState: 'none' },
    ],
    ...overrides,
  };
}

function assignBody(overrides: Record<string, unknown> = {}) {
  return {
    auditId,
    assignmentId,
    replayed: false,
    tenantId,
    currency: 'CNY',
    assigned: 324,
    noRate: 2,
    blocked: 0,
    chargeTotal: '58.35',
    balanceBefore: '-35.20',
    balanceAfter: '-93.55',
    affectedMonths: [
      { month: '2026-09', statementState: 'final' },
      { month: '2026-10', statementState: 'live' },
      { month: '2026-08', statementState: 'none' },
    ],
    ...overrides,
  };
}

function listOf(path: string) {
  const params = new URL(path, 'http://localhost').searchParams;
  if (params.get('status') === 'ignored')
    return listed('ignored', [ignoredRow], 1);
  if (params.get('tag') === 'ABC01')
    return listed('pending', [pendingRows[0]], 326);
  return listed('pending', pendingRows);
}

function renderUnassigned(
  routes: Record<string, ApiHandler> = {},
  path = '/admin/unassigned',
) {
  const { calls, handler } = adminApi({
    'GET /api/admin/unassigned-cdrs/summary': () => ({
      status: 200,
      body: { pending: 338, ignored: 5 },
    }),
    'GET /api/admin/unassigned-cdrs/groups': () => ({
      status: 200,
      body: groups,
    }),
    'GET /api/admin/unassigned-cdrs': (url) => ({
      status: 200,
      body: listOf(url),
    }),
    'GET /api/admin/tenants': () => ({
      status: 200,
      body: {
        items: [tenant],
        pagination: { page: 1, pageSize: 100, total: 1 },
      },
    }),
    ...routes,
  });
  return { calls, ...renderApp(path, handler) };
}

const posts = (
  calls: { method: string; path: string; body: unknown }[],
  path: string,
) => calls.filter((call) => call.method === 'POST' && call.path === path);

/** 点开租户下拉（单行，运营稿 3d）并选一个选项；下拉的列表挂在对话框之外。 */
async function pickTenant(
  user: ReturnType<typeof userEvent.setup>,
  dialog: HTMLElement,
  name: RegExp,
) {
  await user.click(
    within(dialog).getByRole('combobox', { name: /^归属到租户/ }),
  );
  await user.click(await screen.findByRole('option', { name }));
}

async function chooseAbcGroup(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', { name: /疑似拼写错误，相近：ABC001/ }),
  );
  await user.click(
    await screen.findByRole('button', {
      name: '选择「标签 ABC01」全部 326 条',
    }),
  );
}

describe('unassigned calls', () => {
  it('groups a similar tenant, then shows affected months before and after assigning', async () => {
    const user = userEvent.setup();
    const { calls } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 200,
        body: previewBody(),
      }),
      'POST /api/admin/unassigned-cdrs/assign': () => ({
        status: 200,
        body: assignBody(),
      }),
    });
    const table = await screen.findByRole('table');
    expectBillingTenantHint();
    expect(
      screen.getByRole('button', { name: /话单未携带租户标签/ }),
    ).toBeVisible();
    expect(within(table).getByText(/校验失败 · 不可分配/)).toBeVisible();
    expect(within(table).getByText(/接收时间/)).toBeVisible();
    const nav = screen.getAllByRole('navigation', { name: '主导航' })[0]!;
    expect(
      within(nav).getByRole('link', { name: /未归属话单/ }),
    ).toHaveTextContent('未归属话单338');

    await chooseAbcGroup(user);
    await user.click(screen.getByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    // 运营稿 3d：单行下拉，没选时写「选择租户」；点开后相近租户置顶并带「与标签 ABC01 相近」。
    const trigger = within(dialog).getByRole('combobox', {
      name: '归属到租户：选择租户',
    });
    expect(trigger).toHaveTextContent('选择租户');
    expect(within(dialog).queryByRole('radio')).toBeNull();
    await user.click(trigger);
    const option = await screen.findByRole('option', { name: /ABC001/ });
    expect(option).toHaveTextContent(
      'ABC001深圳市某某科技有限公司与标签 ABC01 相近',
    );
    expect(
      screen.getByRole('combobox', { name: '搜索编码或名称' }),
    ).toBeVisible();
    await user.click(option);
    // 运营稿 3e：选中后下拉收起，一行显示「编码 名称（币种）」。
    expect(screen.queryByRole('option')).toBeNull();
    expect(
      within(dialog).getByRole('combobox', {
        name: '归属到租户：ABC001　深圳市某某科技有限公司（CNY）',
      }),
    ).toHaveTextContent('ABC001 深圳市某某科技有限公司（CNY）');

    expect(await within(dialog).findByText('324 条')).toBeVisible();
    expect(dialog).toHaveTextContent('扣费合计');
    expect(dialog).toHaveTextContent('¥58.35');
    expect(dialog).toHaveTextContent('匹配不到费率');
    expect(dialog).toHaveTextContent('2 条');
    expect(dialog).toHaveTextContent(
      '接通时（2026-08-05）ABC001 还没有生效的费率',
    );
    expect(dialog).toHaveTextContent(
      '第一个费率版本自 2026-08-12 09:30 起生效',
    );
    expect(dialog).toHaveTextContent('不能回溯');
    expect(dialog).not.toHaveTextContent('请先在费率表补充该前缀');
    expect(dialog).not.toHaveTextContent('最接近');
    expect(dialog).toHaveTextContent(
      '确认后从 ABC001 余额扣除 ¥58.35（-¥35.20 → -¥93.55），并记入操作日志。',
    );
    expect(dialog).toHaveTextContent('受影响的月份');
    expect(dialog).toHaveTextContent('2026年9月 · 已出账，需重新生成');
    expect(dialog).toHaveTextContent('2026年10月 · 当前月，账单尚未生成');
    expect(dialog).toHaveTextContent('2026年8月 · 账单尚未生成');
    expect(
      within(dialog).queryByRole('link', { name: '前往账单页重新生成' }),
    ).toBeNull();

    await user.click(
      within(dialog).getByRole('button', { name: '确认归属 324 条并扣费' }),
    );
    expect(
      await within(dialog).findByRole('heading', { name: '归属完成' }),
    ).toBeVisible();
    expect(dialog).toHaveTextContent('已归属 324 条到 ABC001');
    expect(dialog).toHaveTextContent('2026年9月 · 已出账，需重新生成');
    expect(dialog).toHaveTextContent('2026年10月 · 当前月，账单尚未生成');
    expect(dialog).toHaveTextContent('2026年8月 · 账单尚未生成');
    const links = within(dialog).getAllByRole('link', {
      name: '前往账单页重新生成',
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute(
      'href',
      `/admin/tenants/${tenantId}?tab=statements&statementMonth=2026-09`,
    );

    const preview = posts(calls, '/api/admin/unassigned-cdrs/assign-preview');
    const assign = posts(calls, '/api/admin/unassigned-cdrs/assign');
    expect(preview).toHaveLength(1);
    expect(preview[0]?.body).toMatchObject({
      tenantId,
      selection: { group: { tag: 'ABC01' } },
    });
    expect(assign).toHaveLength(1);
    expect(assign[0]?.body).toMatchObject({
      tenantId,
      selection: { group: { tag: 'ABC01' } },
      expected: { assignable: 324, noRate: 2, chargeTotal: '58.35' },
    });
    expect(
      (assign[0]?.body as { idempotencyKey: string }).idempotencyKey,
    ).toMatch(/^web:/);
  });

  it('lists the similar tenant first, searches among many tenants on the server, and previews the one picked last', async () => {
    const user = userEvent.setup();
    const other = (n: number, code: string, currency: 'CNY' | 'USD') => ({
      ...tenant,
      id: id(900 + n),
      code,
      name: `${code} 有限公司`,
      currency,
    });
    const everyone = [
      tenant,
      other(1, 'BJH003', 'CNY'),
      other(2, 'XYZ002', 'USD'),
    ];
    const { calls } = renderUnassigned({
      'GET /api/admin/tenants': (url) => {
        const search = new URL(url, 'http://localhost').searchParams.get(
          'search',
        );
        const items = search
          ? everyone.filter((item) => item.code.includes(search))
          : everyone;
        return {
          status: 200,
          // 总数大于一页：提示只显示前 100 个。
          body: {
            items,
            pagination: { page: 1, pageSize: 100, total: 130 },
          },
        };
      },
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 200,
        body: previewBody(),
      }),
    });
    await chooseAbcGroup(user);
    await user.click(screen.getByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await user.click(
      within(dialog).getByRole('combobox', { name: /^归属到租户/ }),
    );
    // 相近租户（标签 ABC01 拼写相近）置顶，其余租户按币种标注。
    await screen.findByRole('option', { name: /BJH003/ });
    const names = screen
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual([
      'ABC001深圳市某某科技有限公司与标签 ABC01 相近',
      'BJH003BJH003 有限公司CNY',
      'XYZ002XYZ002 有限公司USD',
    ]);
    expect(screen.getByText('只显示前 100 个，请搜索编码或名称')).toBeVisible();
    // 租户多时先搜索：搜索词交给服务端，列表只剩匹配的租户。
    await user.type(
      screen.getByRole('combobox', { name: '搜索编码或名称' }),
      'XYZ',
    );
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(
      calls.some(
        (call) =>
          call.path.includes('/api/admin/tenants?') &&
          call.path.includes('search=XYZ'),
      ),
    ).toBe(true);
    await user.click(screen.getByRole('option', { name: /XYZ002/ }));
    await waitFor(() =>
      expect(
        posts(calls, '/api/admin/unassigned-cdrs/assign-preview').map(
          (call) => (call.body as { tenantId: string }).tenantId,
        ),
      ).toEqual([id(902)]),
    );
    expect(
      within(dialog).getByRole('combobox', {
        name: '归属到租户：XYZ002　XYZ002 有限公司（USD）',
      }),
    ).toBeVisible();
    // 再选另一个租户重新预览；再点已选的这个不重复预览。
    await pickTenant(user, dialog, /ABC001/);
    await waitFor(() =>
      expect(
        posts(calls, '/api/admin/unassigned-cdrs/assign-preview'),
      ).toHaveLength(2),
    );
    await pickTenant(user, dialog, /ABC001/);
    expect(
      posts(calls, '/api/admin/unassigned-cdrs/assign-preview'),
    ).toHaveLength(2);
    expect(
      posts(calls, '/api/admin/unassigned-cdrs/assign-preview')[1]?.body,
    ).toMatchObject({ tenantId });
  });

  it('shows the currency of a similar tenant picked before the tenant list has it', async () => {
    const user = userEvent.setup();
    const { calls } = renderUnassigned({
      // 租户列表里没有相近租户 ABC001（例如排在前 100 个之外）：币种只能等预览补上。
      'GET /api/admin/tenants': () => ({
        status: 200,
        body: {
          items: [
            { ...tenant, id: id(901), code: 'BJH003', name: 'BJH003 有限公司' },
          ],
          pagination: { page: 1, pageSize: 100, total: 130 },
        },
      }),
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 200,
        body: previewBody(),
      }),
    });
    await chooseAbcGroup(user);
    await user.click(screen.getByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    await waitFor(() =>
      expect(
        posts(calls, '/api/admin/unassigned-cdrs/assign-preview'),
      ).toHaveLength(1),
    );
    expect(
      await within(dialog).findByRole('combobox', {
        name: `归属到租户：ABC001${String.fromCharCode(0x3000)}深圳市某某科技有限公司（CNY）`,
      }),
    ).toBeVisible();
  });

  it('re-previews after a stale conflict and retries with the same idempotency key', async () => {
    const user = userEvent.setup();
    let previews = 0;
    const { calls } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => {
        previews += 1;
        return {
          status: 200,
          body:
            previews === 1
              ? previewBody()
              : previewBody({ assignable: 320, chargeTotal: '57' }),
        };
      },
      'POST /api/admin/unassigned-cdrs/assign': () =>
        posts(calls, '/api/admin/unassigned-cdrs/assign').length === 1
          ? { status: 409, body: apiError('UNASSIGNED_PREVIEW_STALE') }
          : {
              status: 200,
              body: assignBody({
                assigned: 320,
                chargeTotal: '57',
                balanceAfter: '-92.20',
              }),
            },
    });
    await chooseAbcGroup(user);
    await user.click(await screen.findByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 324 条并扣费',
      }),
    );
    expect(await within(dialog).findByRole('status')).toHaveTextContent(
      '预览之后数据已变化，请重新预览',
    );
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 320 条并扣费',
      }),
    );
    expect(
      await within(dialog).findByRole('heading', { name: '归属完成' }),
    ).toBeVisible();
    const assign = posts(calls, '/api/admin/unassigned-cdrs/assign');
    expect(assign).toHaveLength(2);
    const keys = assign.map(
      (call) => (call.body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toMatch(/^web:/);
    expect(keys[1]).toBe(keys[0]);
    expect(assign[1]?.body).toMatchObject({
      expected: { assignable: 320, noRate: 2, chargeTotal: '57' },
    });
  });

  it('shows the done page without waiting for the list refetch', async () => {
    const user = userEvent.setup();
    let assigned = false;
    const never = new Promise<never>(() => {});
    const { calls } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 200,
        body: previewBody(),
      }),
      'POST /api/admin/unassigned-cdrs/assign': () => {
        assigned = true;
        return { status: 200, body: assignBody() };
      },
      // 归属之后，列表、分组、条数的重新请求一直不返回。
      'GET /api/admin/unassigned-cdrs/summary': () =>
        assigned ? never : { status: 200, body: { pending: 338, ignored: 5 } },
      'GET /api/admin/unassigned-cdrs/groups': () =>
        assigned ? never : { status: 200, body: groups },
      'GET /api/admin/unassigned-cdrs': (url) =>
        assigned ? never : { status: 200, body: listOf(url) },
    });
    await chooseAbcGroup(user);
    await user.click(await screen.findByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 324 条并扣费',
      }),
    );
    expect(
      await within(dialog).findByRole('heading', { name: '归属完成' }),
    ).toBeVisible();
    // 刷新已经发出，只是没有返回。
    await waitFor(() =>
      expect(
        calls.filter(
          (call) =>
            call.method === 'GET' &&
            call.path.startsWith('/api/admin/unassigned-cdrs/summary'),
        ).length,
      ).toBeGreaterThan(1),
    );
  });

  it('refreshes and locks confirm when the selection has nothing left to assign', async () => {
    const user = userEvent.setup();
    let previews = 0;
    const { calls } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => {
        previews += 1;
        return {
          status: 200,
          body:
            previews === 1
              ? previewBody()
              : previewBody({ assignable: 0, chargeTotal: '0' }),
        };
      },
      'POST /api/admin/unassigned-cdrs/assign': () => ({
        status: 409,
        body: apiError('UNASSIGNED_NOTHING_TO_ASSIGN'),
      }),
    });
    await chooseAbcGroup(user);
    await user.click(await screen.findByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    const summaryGets = () =>
      calls.filter(
        (call) =>
          call.method === 'GET' &&
          call.path.startsWith('/api/admin/unassigned-cdrs/summary'),
      ).length;
    const before = summaryGets();
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 324 条并扣费',
      }),
    );
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '选择中没有可分配的待处理话单',
    );
    // 列表被刷新，确认键不能再按。
    await waitFor(() => expect(summaryGets()).toBeGreaterThan(before));
    expect(
      within(dialog).getByRole('button', { name: '确认归属 324 条并扣费' }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(previews).toBe(2));
    expect(
      await within(dialog).findByRole('button', {
        name: '确认归属 0 条并扣费',
      }),
    ).toBeDisabled();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(posts(calls, '/api/admin/unassigned-cdrs/assign')).toHaveLength(1);
  });

  it('uses a new idempotency key after a conflict on the old one', async () => {
    const user = userEvent.setup();
    const { calls } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 200,
        body: previewBody(),
      }),
      'POST /api/admin/unassigned-cdrs/assign': () =>
        posts(calls, '/api/admin/unassigned-cdrs/assign').length === 1
          ? { status: 409, body: apiError('IDEMPOTENCY_CONFLICT') }
          : { status: 200, body: assignBody() },
    });
    await chooseAbcGroup(user);
    await user.click(await screen.findByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 324 条并扣费',
      }),
    );
    await within(dialog).findByRole('alert');
    expect(
      within(dialog).getByRole('button', { name: '确认归属 324 条并扣费' }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '刷新' }));
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 324 条并扣费',
      }),
    );
    expect(
      await within(dialog).findByRole('heading', { name: '归属完成' }),
    ).toBeVisible();
    const keys = posts(calls, '/api/admin/unassigned-cdrs/assign').map(
      (call) => (call.body as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('shows the server batch limit instead of capping the selection locally', async () => {
    const user = userEvent.setup();
    renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 400,
        body: apiError('VALIDATION_ERROR', {
          issues: [{ path: [], message: '一次最多处理 500 条，请分批处理' }],
        }),
      }),
    });
    await chooseAbcGroup(user);
    await user.click(screen.getByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('一次最多处理 500 条，请分批处理');
  });

  it('requires an ignore reason, then records the quick reason', async () => {
    const user = userEvent.setup();
    const { calls } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/ignore': () => ({
        status: 200,
        body: { changed: 1, auditId },
      }),
    });
    const table = await screen.findByRole('table');
    await user.click(
      within(table).getByRole('checkbox', {
        name: '选择 13800000001 呼 18760000001',
      }),
    );
    await user.click(screen.getByRole('button', { name: '忽略' }));
    const dialog = await screen.findByRole('dialog', { name: '忽略 1 条话单' });
    expect(dialog).toHaveTextContent(
      '忽略的话单不计费，移到「已忽略」标签页，可随时撤销。忽略和撤销均记入操作日志。',
    );
    await user.click(within(dialog).getByRole('button', { name: '忽略 1 条' }));
    expect(within(dialog).getByText('请填写忽略原因')).toBeVisible();
    expect(posts(calls, '/api/admin/unassigned-cdrs/ignore')).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: '测试呼叫' }));
    expect(
      within(dialog).getByRole('textbox', { name: '忽略原因' }),
    ).toHaveValue('测试呼叫，不属于任何客户');
    await user.click(within(dialog).getByRole('button', { name: '忽略 1 条' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '已忽略 1 条，可在「已忽略」中撤销',
    );
    expect(posts(calls, '/api/admin/unassigned-cdrs/ignore')[0]?.body).toEqual({
      selection: { ids: [id(1)] },
      reason: '测试呼叫，不属于任何客户',
    });
  });

  it('on a phone puts the actions in a bar fixed at the bottom, with room under the last card', async () => {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const user = userEvent.setup();
    const { calls } = renderUnassigned();
    const table = await screen.findByRole('table');
    // 没有选择时没有操作栏。
    expect(screen.queryByRole('region', { name: '批量操作' })).toBeNull();
    // 没有操作栏就没有为它留的底部空白。
    expect(
      screen.getByRole('tabpanel', { name: /待处理/ }).className,
    ).not.toContain('safe-area-inset-bottom');
    await user.click(
      within(table).getByRole('checkbox', {
        name: '选择 13800000001 呼 18760000001',
      }),
    );
    // 运营稿 4a：「忽略」「归属到租户 (n)」固定在视口底部，并避开系统安全区。
    const bar = await screen.findByRole('region', { name: '批量操作' });
    expect(bar).toHaveClass('fixed', 'inset-x-0', 'bottom-0');
    expect(bar.className).toContain('env(safe-area-inset-bottom)');
    expect(within(bar).getByRole('button', { name: '忽略' })).toBeVisible();
    expect(
      within(bar).getByRole('button', { name: '归属到租户 (1)' }),
    ).toBeVisible();
    // 列表里的选择条不再带这两个按钮，页面底部留出操作栏的高度。
    expect(screen.getAllByRole('button', { name: '忽略' })).toHaveLength(1);
    const panel = screen.getByRole('tabpanel', { name: /待处理/ });
    expect(panel.className).toContain(
      'pb-[calc(6rem+env(safe-area-inset-bottom))]',
    );
    await user.click(within(bar).getByRole('button', { name: '忽略' }));
    expect(
      await screen.findByRole('dialog', { name: '忽略 1 条话单' }),
    ).toBeVisible();
    expect(posts(calls, '/api/admin/unassigned-cdrs/ignore')).toHaveLength(0);
  });

  it('lists ignored calls and undoes one', async () => {
    const user = userEvent.setup();
    const { calls, location } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/unignore': () => ({
        status: 200,
        body: { changed: 1, auditId },
      }),
    });
    await user.click(await screen.findByRole('tab', { name: /已忽略/ }));
    await waitFor(() =>
      expect(location()).toBe('/admin/unassigned?tab=ignored'),
    );
    const table = await screen.findByRole('table');
    // 运营稿 3g：已忽略页签同样显示「提示」警示条，且一句话在同一个说明里排版。
    expectBillingTenantHint();
    expect(within(table).getByText('测试呼叫，不属于任何客户')).toBeVisible();
    expect(within(table).getByText('王敏 · 2026-10-01 10:00:00')).toBeVisible();
    await user.click(within(table).getByRole('button', { name: '撤销忽略' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '已撤销忽略，话单回到「待处理」',
    );
    expect(
      posts(calls, '/api/admin/unassigned-cdrs/unignore')[0]?.body,
    ).toEqual({
      selection: { ids: [id(9)] },
    });
  });

  it('points every tab at an existing panel and activates tabs manually', async () => {
    const user = userEvent.setup();
    const { location } = renderUnassigned();
    const pending = await screen.findByRole('tab', { name: /待处理/ });
    const ignored = screen.getByRole('tab', { name: /已忽略/ });
    for (const tab of [pending, ignored]) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!);
      expect(panel).not.toBeNull();
      expect(panel).toHaveAttribute('role', 'tabpanel');
    }
    expect(
      document.getElementById(ignored.getAttribute('aria-controls')!),
    ).not.toBeVisible();

    pending.focus();
    await user.keyboard('{ArrowRight}');
    expect(ignored).toHaveFocus();
    expect(location()).toBe('/admin/unassigned');
    expect(pending).toHaveAttribute('aria-selected', 'true');

    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(location()).toBe('/admin/unassigned?tab=ignored'),
    );
  });

  it('shows the empty pending state and an empty ignored tab', async () => {
    const user = userEvent.setup();
    const { calls } = renderUnassigned({
      'GET /api/admin/unassigned-cdrs/summary': () => ({
        status: 200,
        body: { pending: 0, ignored: 0 },
      }),
      'GET /api/admin/unassigned-cdrs': () => ({
        status: 200,
        body: listed('ignored', [], 0),
      }),
    });
    expect(await screen.findByText('所有话单都已归属')).toBeVisible();
    expect(screen.getByText('没有待处理的未归属话单')).toBeVisible();
    // 运营稿 3h：清空后提示条仍在。
    expectBillingTenantHint();
    expect(calls.some((call) => call.path.includes('/groups'))).toBe(false);
    const nav = screen.getAllByRole('navigation', { name: '主导航' })[0]!;
    expect(
      within(nav).getByRole('link', { name: '未归属话单' }),
    ).toHaveTextContent(/^未归属话单$/);
    await user.click(screen.getByRole('tab', { name: /已忽略/ }));
    expect(await screen.findByText('没有已忽略的话单')).toBeVisible();
  });

  it('keeps an empty tag in the address and asks the list for that group', async () => {
    const { calls, location } = renderUnassigned(
      {},
      '/admin/unassigned?tab=bogus&page=0&tag=',
    );
    expect(
      await screen.findByRole('button', { name: /话单未携带租户标签/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    const table = await screen.findByRole('table');
    expect(within(table).getByText('（空）')).toBeVisible();
    await waitFor(() => expect(location()).toBe('/admin/unassigned?tag='));
    const list = calls.find((call) =>
      call.path.startsWith('/api/admin/unassigned-cdrs?'),
    );
    expect(
      new URL(list?.path ?? '', 'http://localhost').searchParams.get('tag'),
    ).toBe('');
  });

  it('keeps a numeric tag the router coerced', async () => {
    const { calls, location } = renderUnassigned(
      {
        'GET /api/admin/unassigned-cdrs/groups': () => ({
          status: 200,
          body: {
            total: 1,
            groups: [
              {
                tag: '326',
                count: 1,
                reasons: [{ reason: '租户不存在', count: 1 }],
                suggestedTenants: [],
              },
            ],
          },
        }),
      },
      '/admin/unassigned?tag=326',
    );
    expect(
      await screen.findByRole('button', { name: /标签 326/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    // 纯数字标签还原成字符串后，路由会写成带引号的查询串，避免再被收成 number。
    await waitFor(() =>
      expect(location()).toBe('/admin/unassigned?tag=%22326%22'),
    );
    const list = calls.find((call) =>
      call.path.startsWith('/api/admin/unassigned-cdrs?'),
    );
    expect(
      new URL(list?.path ?? '', 'http://localhost').searchParams.get('tag'),
    ).toBe('326');
  });
});

async function expectSignedOutAgain(
  location: () => string,
  stillThere?: HTMLElement,
) {
  const expired = await screen.findByRole('dialog', {
    name: '登录已过期，请重新登录',
  });
  // 过期对话框打开后，底下的页面会被标成 aria-hidden，错误条仍要算进去。
  expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
  if (stillThere) expect(stillThere).toBeInTheDocument();
  await userEvent.click(
    within(expired).getByRole('button', { name: '重新登录' }),
  );
  await waitFor(() => expect(location()).toBe('/admin/login?reason=expired'));
  expect(await screen.findByRole('status')).toHaveTextContent(
    '登录已过期，请重新登录登录后将返回之前的页面',
  );
}

describe('unassigned session expiry', () => {
  it('a 401 while ignoring asks the admin to sign in again', async () => {
    const user = userEvent.setup();
    const { location } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/ignore': () => ({
        status: 401,
        body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
      }),
    });
    const table = await screen.findByRole('table');
    await user.click(
      within(table).getByRole('checkbox', {
        name: '选择 13800000001 呼 18760000001',
      }),
    );
    await user.click(screen.getByRole('button', { name: '忽略' }));
    const dialog = await screen.findByRole('dialog', { name: '忽略 1 条话单' });
    await user.click(within(dialog).getByRole('button', { name: '测试呼叫' }));
    await user.click(within(dialog).getByRole('button', { name: '忽略 1 条' }));
    await expectSignedOutAgain(location, dialog);
  });

  it('a 401 while previewing an assignment asks the admin to sign in again', async () => {
    const user = userEvent.setup();
    const { location } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 401,
        body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
      }),
    });
    await chooseAbcGroup(user);
    await user.click(await screen.findByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    await expectSignedOutAgain(location, dialog);
  });

  it('a 401 while assigning asks the admin to sign in again', async () => {
    const user = userEvent.setup();
    const { location } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/assign-preview': () => ({
        status: 200,
        body: previewBody(),
      }),
      'POST /api/admin/unassigned-cdrs/assign': () => ({
        status: 401,
        body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
      }),
    });
    await chooseAbcGroup(user);
    await user.click(await screen.findByRole('button', { name: '归属到租户' }));
    const dialog = await screen.findByRole('dialog', { name: '归属到租户' });
    await pickTenant(user, dialog, /ABC001/);
    await user.click(
      await within(dialog).findByRole('button', {
        name: '确认归属 324 条并扣费',
      }),
    );
    await expectSignedOutAgain(location, dialog);
  });

  it('a 401 while undoing an ignore asks the admin to sign in again', async () => {
    const user = userEvent.setup();
    const { location } = renderUnassigned({
      'POST /api/admin/unassigned-cdrs/unignore': () => ({
        status: 401,
        body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
      }),
    });
    await user.click(await screen.findByRole('tab', { name: /已忽略/ }));
    const table = await screen.findByRole('table');
    await user.click(within(table).getByRole('button', { name: '撤销忽略' }));
    const expired = await screen.findByRole('dialog', {
      name: '登录已过期，请重新登录',
    });
    expect(
      within(table).getByRole('button', { name: '撤销忽略', hidden: true }),
    ).toBeEnabled();
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
    await user.click(within(expired).getByRole('button', { name: '重新登录' }));
    await waitFor(() => expect(location()).toBe('/admin/login?reason=expired'));
  });
});

describe('unassigned calls on a phone', () => {
  function mobileStyles() {
    const style = document.createElement('style');
    style.textContent = '.hidden { display: none; }';
    document.head.append(style);
    return () => style.remove();
  }

  it('uses cards instead of the table', async () => {
    const unstyle = mobileStyles();
    try {
      renderUnassigned();
      const card = await screen.findByRole('article', {
        name: '10010，主叫 10086',
      });
      expect(card).toBeVisible();
      expect(card).toHaveTextContent('接收时间');
      expect(card).toHaveTextContent('不可分配');
      expect(screen.queryByRole('table')).toBeNull();
    } finally {
      unstyle();
    }
  });
});
