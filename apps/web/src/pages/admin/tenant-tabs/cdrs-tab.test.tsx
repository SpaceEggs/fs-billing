import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiry } from '../../../lib/session';
import {
  adminApi,
  apiError,
  renderApp,
  type ApiHandler,
} from '../../../test/app';
import { answeredCdr, cdrList } from '../../../test/cdr';

const downloadBlob = vi.hoisted(() =>
  vi.fn<(filename: string, blob: Blob) => void>(),
);
vi.mock('../../../lib/download', () => ({
  downloadBlob,
  downloadText: vi.fn(),
}));

const tenantId = '00000000-0000-4000-8000-00000000a001';
const detailPath = `/api/admin/tenants/${tenantId}`;
const cdrsPath = `${detailPath}/cdrs`;

const detail = {
  id: tenantId,
  code: 'ABC001',
  name: '深圳市某某科技有限公司',
  currency: 'CNY',
  status: 'active',
  health: 'normal',
  settingsConfigured: true,
  balance: '500',
  overdraftLimit: '100',
  availableBalance: '600',
  monthConsumption: '0',
  pendingReceivable: '0',
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: { overdraftLimit: '100', lowBalanceThreshold: '200', emails: [] },
  createdAt: '2026-08-12T02:31:02.000Z',
};

const unverifiedRow = answeredCdr(3, {
  callee: '18765551234',
  country: '牙买加',
  iso: 'JM',
  description: null,
  matchedPrefix: '1876',
  rate: '0.2500',
  unverified: true,
});
const verifiedRow = answeredCdr(1, { unverified: false });

function cdrApp(
  path: string,
  list?: (url: string) => { status: number; body?: unknown },
  extra: Record<string, ApiHandler> = {},
) {
  const fetchList =
    list ??
    (() => ({
      status: 200,
      body: cdrList([verifiedRow, unverifiedRow], { unverifiedCalls: 1 }),
    }));
  const lists: URLSearchParams[] = [];
  const exports: { path: string; body: unknown }[] = [];
  const { handler } = adminApi({
    [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
    [`GET ${cdrsPath}`]: (url) => {
      lists.push(new URL(url, 'http://localhost').searchParams);
      return fetchList(url);
    },
    [`GET ${cdrsPath}/countries`]: () => ({
      status: 200,
      body: { countries: ['英国', '牙买加'] },
    }),
    [`POST ${cdrsPath}/export`]: (url, init) => {
      exports.push({ path: url, body: JSON.parse(init.body as string) });
      return {
        status: 200,
        file: {
          text: 'csv',
          type: 'text/csv; charset=utf-8',
          disposition:
            'attachment; filename="cdrs_ABC001_2026-10-01_2026-10-17.csv"',
        },
      };
    },
    [`GET ${detailPath}/cdr-deletions`]: () => ({
      status: 200,
      body: {
        tenant: {
          id: tenantId,
          code: 'ABC001',
          name: '深圳市某某科技有限公司',
        },
        year: 2026,
        months: Array.from({ length: 12 }, (_, index) => ({
          month: `2026-${String(index + 1).padStart(2, '0')}`,
          state: index + 1 === 8 ? 'deletable' : 'no_statement',
          cdrCount: index + 1 === 8 ? 9642 : null,
          blockedReasons: [],
          statementId: null,
          deleted: null,
        })),
      },
    }),
    [`GET ${detailPath}/ledger`]: () => ({
      status: 200,
      body: {
        currency: 'CNY',
        balance: '500',
        totalAmount: '0',
        items: [],
        pagination: { page: 1, pageSize: 25, total: 0 },
      },
    }),
    ...extra,
  });
  return { lists, exports, ...renderApp(path, handler) };
}

beforeEach(() => {
  // 北京时间 2026-10-17 18:00。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
  downloadBlob.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionExpiry.clear();
});

const path = `/admin/tenants/${tenantId}?tab=cdrs`;

describe('admin tenant CDR tab', () => {
  it('is a tab of the tenant detail between rates and statements', async () => {
    cdrApp(`/admin/tenants/${tenantId}`);
    const nav = await screen.findByRole('navigation', { name: '租户详情' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['概况', '余额流水', '费率', '话单', '账单', '设置', '门户账号']);
    await userEvent.click(within(nav).getByRole('link', { name: '话单' }));
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('lists the tenant calls with the unverified tag and the merged country label', async () => {
    const { lists } = cdrApp(path);
    const rows = within(await screen.findByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('英国 · 手机');
    expect(rows[1]).not.toHaveTextContent('未经验证');
    expect(rows[2]).toHaveTextContent('牙买加');
    expect(rows[2]).toHaveTextContent('未经验证');
    expect(Object.fromEntries(lists.at(-1)!)).toEqual({
      from: '2026-10-01',
      to: '2026-10-17',
      status: 'answered',
      unverifiedOnly: 'false',
      page: '1',
    });
    expect(
      screen.getAllByRole('region', { name: '汇总' })[0],
    ).toHaveTextContent('其中未经验证 1 条');
  });

  it('shows the delete button and hides the alert link of the later phase', async () => {
    cdrApp(`${path}&unverifiedOnly=true`);
    await screen.findByRole('table');
    expect(screen.getAllByRole('button', { name: '删除话单' })).toHaveLength(2);
    expect(document.body).not.toHaveTextContent('查看告警');
    expect(document.body).not.toHaveTextContent('关联告警');
  });

  it('banners each deleted month in the selected range, with metadata only when it exists', async () => {
    cdrApp(path, () => ({
      status: 200,
      body: cdrList([verifiedRow], {
        unverifiedCalls: 0,
        deletedMonths: [
          {
            month: '2026-07',
            count: null,
            deletedBy: null,
            deletedAt: null,
          },
          {
            month: '2026-08',
            count: 9642,
            deletedBy: {
              id: '00000000-0000-4000-8000-000000000009',
              name: '王敏',
            },
            deletedAt: '2026-10-28T06:03:00.000Z',
          },
        ],
      }),
    }));
    const banner = await screen.findByRole('region', { name: '已删除的话单' });
    expect(within(banner).getByText('2026年7月 的话单已删除')).toBeVisible();
    expect(
      within(banner).getByText(
        '2026年8月 的话单已删除 · 共 9,642 条 · 王敏 删除于 2026-10-28 14:03',
      ),
    ).toBeVisible();
    expect(screen.getByRole('table')).toBeVisible();
  });

  it('a 401 while deleting asks the admin to sign in again', async () => {
    const user = userEvent.setup();
    const { location } = cdrApp(path, undefined, {
      [`POST ${detailPath}/cdr-deletions`]: () => ({
        status: 401,
        body: apiError('SESSION_EXPIRED', { action: 'reauthenticate' }),
      }),
    });
    await screen.findByRole('table');
    await user.click(screen.getAllByRole('button', { name: '删除话单' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: '删除话单' });
    await user.click(
      within(dialog).getByRole('button', { name: '开始月份：选择月份' }),
    );
    await user.click(
      await within(dialog).findByRole('button', {
        name: '2026年8月，9,642 条',
      }),
    );
    await user.type(
      within(dialog).getByRole('textbox', { name: /请输入租户编码/ }),
      'ABC001',
    );
    await user.click(
      within(dialog).getByRole('button', { name: '删除 9,642 条话单' }),
    );
    const expired = await screen.findByRole('dialog', {
      name: '登录已过期，请重新登录',
    });
    expect(dialog).toBeInTheDocument();
    expect(screen.queryByRole('alert', { hidden: true })).toBeNull();
    await user.click(within(expired).getByRole('button', { name: '重新登录' }));
    await waitFor(() => expect(location()).toBe('/admin/login?reason=expired'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      '登录已过期，请重新登录登录后将返回之前的页面',
    );
  });

  it('opens the delete dialog from the calls tab', async () => {
    const user = userEvent.setup();
    cdrApp(path);
    await screen.findByRole('table');
    await user.click(screen.getAllByRole('button', { name: '删除话单' })[0]!);
    expect(
      await screen.findByRole('dialog', { name: '删除话单' }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: '开始月份：选择月份' }),
    ).toBeVisible();
  });

  it('filters to the unverified calls and explains them without the fault time or alerts', async () => {
    const user = userEvent.setup();
    const { lists, location } = cdrApp(path, (url) =>
      new URL(url, 'http://localhost').searchParams.get('unverifiedOnly') ===
      'true'
        ? {
            status: 200,
            body: cdrList([unverifiedRow], { unverifiedCalls: 1, total: 4 }),
          }
        : {
            status: 200,
            body: cdrList([verifiedRow, unverifiedRow], {
              unverifiedCalls: 1,
            }),
          },
    );
    await screen.findByRole('table');
    expect(screen.queryByText(/授权超时期间/)).toBeNull();
    await user.click(screen.getAllByLabelText('仅看未经验证')[0]!);
    await waitFor(() =>
      expect(lists.at(-1)!.get('unverifiedOnly')).toBe('true'),
    );
    expect(location()).toContain('unverifiedOnly=true');
    const banner = (await screen.findAllByText(/由 FreeSWITCH 放行/))[0]!
      .parentElement!;
    expect(banner).toHaveTextContent(
      '未经验证：以下话单发生在计费系统授权超时期间，由 FreeSWITCH 放行，最长 30 分钟，已按费率正常计费。',
    );
    expect(banner.parentElement).toHaveTextContent(
      '仅看未经验证 · 4 条授权超时期间由 FreeSWITCH 放行，最长 30 分钟。',
    );
    expect(document.body).not.toHaveTextContent('2026-09-27');
    expect(document.body).not.toHaveTextContent('查看告警');
    await user.click(screen.getByRole('button', { name: '重置' }));
    await waitFor(() =>
      expect(lists.at(-1)!.get('unverifiedOnly')).toBe('false'),
    );
    expect(location()).not.toContain('unverifiedOnly');
  });

  it('notes when every call in the result is unverified', async () => {
    cdrApp(`${path}&unverifiedOnly=true`, () => ({
      status: 200,
      body: cdrList([unverifiedRow], { unverifiedCalls: 1 }),
    }));
    await screen.findByRole('table');
    expect(
      screen.getAllByRole('region', { name: '汇总' })[0],
    ).toHaveTextContent('全部为未经验证');
  });

  it('shows the verification status and the explanation in the detail of an unverified call only', async () => {
    const user = userEvent.setup();
    cdrApp(path);
    await screen.findByRole('table');
    const [verified, unverified] = screen.getAllByRole('button', {
      name: /查看话单详情/,
    });
    await user.click(verified!);
    let dialog = await screen.findByRole('dialog');
    expect(dialog).not.toHaveTextContent('验证状态');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(unverified!);
    dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('验证状态计费系统授权超时');
    expect(dialog).toHaveTextContent(
      '计费系统故障期间由 FreeSWITCH 放行，最长 30 分钟。通话结束后已按费率补记计费，此标签仅管理后台可见。',
    );
    expect(dialog).not.toHaveTextContent('关联告警');
  });

  it('counts a hidden unanswered call in the answered view', async () => {
    cdrApp(path, () => ({
      status: 200,
      body: cdrList([verifiedRow], { unverifiedCalls: 0, unansweredCalls: 2 }),
    }));
    await screen.findByRole('table');
    expect(
      screen.getAllByRole('region', { name: '汇总' })[0],
    ).toHaveTextContent('另有未接通 2 通');
  });

  it('explains the empty range with the tenant creation date', async () => {
    cdrApp(path, () => ({
      status: 200,
      body: cdrList([], { unverifiedCalls: 0 }),
    }));
    expect(await screen.findByText('本月还没有话单')).toBeVisible();
    expect(
      screen.getByText('该租户创建于 2026-08-12，请调整日期范围'),
    ).toBeVisible();
  });

  it('exports the current filters to the tenant path and records nothing in the page', async () => {
    const user = userEvent.setup();
    const { exports } = cdrApp(
      `${path}&unverifiedOnly=true&country=%E8%8B%B1%E5%9B%BD`,
    );
    await screen.findByRole('table');
    await user.click(screen.getAllByRole('button', { name: '导出 CSV' })[0]!);
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(exports).toEqual([
      {
        path: `${cdrsPath}/export`,
        body: {
          from: '2026-10-01',
          to: '2026-10-17',
          country: '英国',
          status: 'answered',
          unverifiedOnly: true,
        },
      },
    ]);
    expect(downloadBlob.mock.calls[0]![0]).toBe(
      'cdrs_ABC001_2026-10-01_2026-10-17.csv',
    );
  });

  it('keeps the ledger range out of the calls and returns to page one when switching tabs', async () => {
    const user = userEvent.setup();
    const { location, lists } = cdrApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-10-02&to=2026-10-09&page=3`,
    );
    const nav = await screen.findByRole('navigation', { name: '租户详情' });
    await user.click(within(nav).getByRole('link', { name: '话单' }));
    await screen.findByRole('table');
    // 流水的 from / to 原样保留在地址里，但话单没有用它：请求的是本月默认范围，页码已清除。
    expect(location()).toBe(
      `/admin/tenants/${tenantId}?from=2026-10-02&to=2026-10-09&tab=cdrs`,
    );
    expect(Object.fromEntries(lists.at(-1)!)).toMatchObject({
      from: '2026-10-01',
      to: '2026-10-17',
    });
  });

  it('reads the calls range from cdrFrom and cdrTo and leaves the ledger range alone', async () => {
    const user = userEvent.setup();
    const { location, lists } = cdrApp(
      `/admin/tenants/${tenantId}?tab=cdrs&from=2026-10-02&to=2026-10-09&cdrFrom=2026-10-05&cdrTo=2026-10-06`,
    );
    await screen.findByRole('table');
    expect(Object.fromEntries(lists.at(-1)!)).toMatchObject({
      from: '2026-10-05',
      to: '2026-10-06',
    });
    const nav = screen.getByRole('navigation', { name: '租户详情' });
    await user.click(within(nav).getByRole('link', { name: '余额流水' }));
    expect(location()).toBe(
      `/admin/tenants/${tenantId}?from=2026-10-02&to=2026-10-09&cdrFrom=2026-10-05&cdrTo=2026-10-06&tab=ledger`,
    );
  });
});
