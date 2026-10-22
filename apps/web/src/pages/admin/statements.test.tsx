import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, apiError, renderApp } from '../../test/app';
import {
  adminTenant,
  figures,
  listRow,
  septemberFigures,
  statementTenantId,
} from '../../test/statements';

const hzx = {
  id: '00000000-0000-4000-8000-00000000a002',
  code: 'HZX014',
  name: '杭州某某网络有限公司',
};
const nyc = {
  id: '00000000-0000-4000-8000-00000000a003',
  code: 'NYC021',
  name: 'Hudson Contact Center Inc',
};
const fresh = {
  id: '00000000-0000-4000-8000-00000000a004',
  code: 'NEW009',
  name: '新开户租户',
};

const hzxFigures = figures({
  openingBalance: '0',
  recharge: '500',
  gift: '0',
  adjustment: '0',
  callCharges: '200',
  closingBalance: '300',
  calls: 10,
  callMinutes: '20',
});
const cnyTotals = figures({
  openingBalance: '1176.6',
  recharge: '1800',
  gift: '0',
  adjustment: '-25.5',
  callCharges: '2686.3',
  closingBalance: '264.8',
  calls: 12814,
  callMinutes: '49746',
});
const usdFigures = figures({
  openingBalance: '85.4',
  recharge: '200',
  gift: '0',
  adjustment: '0',
  callCharges: '268.1',
  closingBalance: '17.3',
  calls: 0,
  callMinutes: '0',
});

function statementsResponse(month = '2026-09') {
  return {
    month,
    asOf: '2026-10-17T10:00:00.000Z',
    groups: [
      {
        currency: 'CNY',
        tenantCount: 3,
        totals: cnyTotals,
        items: [
          listRow(adminTenant, month, septemberFigures, {
            version: 2,
            generatedAt: '2026-10-02T03:04:05.000Z',
            reconcileStatus: 'stale',
          }),
          listRow(hzx, month, hzxFigures, {
            detailsDeleted: true,
            reconcileStatus: 'inconsistent',
            regenerable: { allowed: false, reason: 'details_deleted' },
          }),
          listRow(fresh, month, null),
        ],
      },
      {
        currency: 'USD',
        tenantCount: 1,
        totals: usdFigures,
        items: [listRow(nyc, month, usdFigures)],
      },
    ],
  };
}

type Query = (month: string) => { status: number; body?: unknown };

function statementsApp(
  path = '/admin/statements',
  options: {
    list?: Query;
    regenerate?: (body: unknown) => { status: number; body?: unknown };
  } = {},
) {
  const months: string[] = [];
  const regenerations: { path: string; body: unknown }[] = [];
  const { handler } = adminApi({
    'GET /api/admin/statements': (url) => {
      const month = new URL(url, 'http://localhost').searchParams.get('month');
      months.push(month ?? '');
      return (
        options.list?.(month ?? '') ?? {
          status: 200,
          body: statementsResponse(month ?? '2026-09'),
        }
      );
    },
    ...Object.fromEntries(
      [statementTenantId, fresh.id].map((id) => [
        `POST /api/admin/tenants/${id}/statements/2026-09/regenerate`,
        (url: string, init: RequestInit) => {
          const body: unknown = JSON.parse(init.body as string);
          regenerations.push({ path: url, body });
          return (
            options.regenerate?.(body) ?? { status: 409, body: apiError('X') }
          );
        },
      ]),
    ),
  });
  return { months, regenerations, ...renderApp(path, handler) };
}

beforeEach(() => {
  // 北京时间 2026-10-17 18:00，默认月份是 2026-09。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const row = (code: string) =>
  screen.getByText(code, { selector: 'td span' }).closest('tr')!;

describe('admin statements page', () => {
  it('lists the previous Beijing month grouped by currency with server totals', async () => {
    const { months, location } = statementsApp();
    const cny = await screen.findByRole('region', { name: 'CNY 账单' });
    expect(months).toEqual(['2026-09']);
    expect(location()).toBe('/admin/statements');
    expect(
      screen.getAllByRole('button', { name: '月份：2026年9月' }).length,
    ).toBeGreaterThan(0);
    expect(within(cny).getByText(/3 个租户 · 1 个未生成/)).toBeVisible();
    const abc = within(cny).getByText('ABC001', { selector: 'td span' });
    expect(abc.closest('tr')).toHaveTextContent('-¥35.20');
    expect(abc.closest('tr')).toHaveTextContent('-¥25.50');
    const total = within(cny).getByText('CNY 合计').closest('tr')!;
    expect(total).toHaveTextContent('¥264.80');
    expect(total).toHaveTextContent('¥2,686.30');
    const usd = screen.getByRole('region', { name: 'USD 账单' });
    expect(within(usd).getByText('USD 合计').closest('tr')).toHaveTextContent(
      '$268.10',
    );
  });

  it('labels the month picker on desktop and puts each phone group header on one line with the call charge total', async () => {
    statementsApp();
    const cny = await screen.findByRole('region', { name: 'CNY 账单' });
    // 电脑：控件上方的小标签「月份」（运营稿 5a）；手机的选择器没有标签（5c）。
    expect(screen.getAllByText('月份', { selector: 'span' })).toHaveLength(1);
    // 手机：组头「CNY · N 个租户」与「扣费合计 ¥…」同一行，页脚只有一句提示（运营稿 5c）。
    expect(
      within(cny).getByText('扣费合计', { exact: false }),
    ).toHaveTextContent('扣费合计 ¥2,686.30');
    expect(within(cny).queryByText('通话扣费合计')).not.toBeInTheDocument();
    expect(screen.getByText('点 ⋯ 查看或重新生成')).toBeInTheDocument();
  });

  it('shows 未生成 for a tenant without a statement and the note slot for mismatches', async () => {
    statementsApp();
    const cny = await screen.findByRole('region', { name: 'CNY 账单' });
    const missing = within(cny)
      .getByText('NEW009', { selector: 'td span' })
      .closest('tr')!;
    expect(missing).toHaveTextContent('未生成');
    expect(
      within(missing).getByRole('button', { name: /重新生成 NEW009/ }),
    ).toBeEnabled();
    const abc = within(cny)
      .getByText('ABC001', { selector: 'td span' })
      .closest('tr')!;
    expect(abc).toHaveTextContent('账单已过期');
    expect(abc).toHaveTextContent('已重新生成 · 原 09-02 02:00');
    const hzxRow = within(cny)
      .getByText('HZX014', { selector: 'td span' })
      .closest('tr')!;
    expect(hzxRow).toHaveTextContent('账单与流水不一致');
    expect(hzxRow).toHaveTextContent('该月话单已删除');
    const regenerate = within(hzxRow).getByRole('button', {
      name: /重新生成 HZX014/,
    });
    expect(regenerate).toBeDisabled();
    expect(regenerate).toHaveAttribute('title', '话单已删除，无法重新计算');
  });

  it('steps months and keeps the default out of the address', async () => {
    const { months, location } = statementsApp(
      '/admin/statements?month=2026-08',
    );
    await screen.findByRole('region', { name: 'CNY 账单' });
    expect(months).toEqual(['2026-08']);
    const [next] = screen.getAllByRole('button', { name: '月份：下个月' });
    expect(next).toBeEnabled();
    await userEvent.click(next!);
    await waitFor(() => expect(months.at(-1)).toBe('2026-09'));
    expect(location()).toBe('/admin/statements');
    // 默认的上月已是最晚可选月份，「›」置灰。
    for (const button of screen.getAllByRole('button', {
      name: '月份：下个月',
    }))
      expect(button).toBeDisabled();
    await userEvent.click(
      screen.getAllByRole('button', { name: '月份：上个月' })[0]!,
    );
    await waitFor(() => expect(months.at(-1)).toBe('2026-08'));
    expect(location()).toBe('/admin/statements?month=2026-08');
  });

  it('falls back to the previous month for a month that is not over yet', async () => {
    const { months } = statementsApp('/admin/statements?month=2026-10');
    await screen.findByRole('region', { name: 'CNY 账单' });
    expect(months).toEqual(['2026-09']);
  });

  it('picks a month from the grid, with later months disabled', async () => {
    const { months } = statementsApp();
    await screen.findByRole('region', { name: 'CNY 账单' });
    await userEvent.click(
      screen.getAllByRole('button', { name: '月份：2026年9月' })[0]!,
    );
    const dialog = await screen.findByRole('dialog', { name: '月份' });
    expect(
      within(dialog).getByRole('button', { name: '2026年10月' }),
    ).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole('button', { name: '2026年3月' }),
    );
    await waitFor(() => expect(months.at(-1)).toBe('2026-03'));
  });

  it('shows an empty state for a month without statements', async () => {
    statementsApp('/admin/statements', {
      list: (month) => ({
        status: 200,
        body: { ...statementsResponse(month), groups: [] },
      }),
    });
    expect(await screen.findByText('2026年9月没有账单')).toBeVisible();
  });

  it('retries a failed load', async () => {
    let calls = 0;
    statementsApp('/admin/statements', {
      list: () =>
        ++calls <= 3
          ? { status: 500, body: apiError('INTERNAL_ERROR') }
          : { status: 200, body: statementsResponse() },
    });
    expect(
      await screen.findByText('账单加载失败', undefined, { timeout: 5000 }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(
      await screen.findByRole('region', { name: 'CNY 账单' }),
    ).toBeVisible();
  });

  it('links to the tenant statement tab for the month', async () => {
    statementsApp();
    const cny = await screen.findByRole('region', { name: 'CNY 账单' });
    expect(
      within(row('ABC001')).getByRole('link', {
        name: /查看 ABC001 2026年9月/,
      }),
    ).toHaveAttribute(
      'href',
      `/admin/tenants/${statementTenantId}?tab=statements&statementMonth=2026-09`,
    );
    expect(cny).toBeVisible();
  });
});

describe('regenerate from the month page', () => {
  const result = (over: Record<string, unknown> = {}) => ({
    auditId: '00000000-0000-4000-8000-0000000000e1',
    month: '2026-09',
    created: false,
    changed: true,
    before: { ...septemberFigures, version: 2 },
    after: {
      ...septemberFigures,
      callCharges: '2500.3',
      closingBalance: '-49.2',
      version: 3,
    },
    staleFollowingMonths: [],
    ...over,
  });

  it('confirms with the current figures and sends the version it saw', async () => {
    const { regenerations } = statementsApp('/admin/statements', {
      regenerate: () => ({
        status: 200,
        body: result({ staleFollowingMonths: ['2026-10'] }),
      }),
    });
    await screen.findByRole('region', { name: 'CNY 账单' });
    await userEvent.click(
      within(row('ABC001')).getByRole('button', { name: /重新生成 ABC001/ }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: '重新生成 ABC001 2026年9月 账单？',
    });
    expect(dialog).toHaveTextContent('¥2,486.30 · 49,726分钟');
    expect(dialog).toHaveTextContent('当前期末余额-¥35.20');
    expect(dialog).toHaveTextContent('生成于2026-10-02 11:04:05');
    expect(dialog).toHaveTextContent('操作人和前后差异记入操作日志');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '重新生成' }),
    );
    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(
      '已重新生成 ABC001 2026年9月 账单（版本 3）：通话扣费 ¥2,486.30 → ¥2,500.30',
    );
    expect(regenerations).toEqual([
      {
        path: `/api/admin/tenants/${statementTenantId}/statements/2026-09/regenerate`,
        body: { expectedVersion: 2 },
      },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
    // 过期的后续月份：不级联，列出来由管理员按顺序处理。
    const alert = screen.getByText('后续月份的账单已过期').parentElement!;
    expect(
      within(alert).getByRole('link', { name: '2026年10月' }),
    ).toHaveAttribute(
      'href',
      `/admin/tenants/${statementTenantId}?tab=statements&statementMonth=2026-10`,
    );
    expect(alert).toHaveTextContent('请按月份顺序逐个重新生成');
  });

  it('reports a no-op without a new version', async () => {
    statementsApp('/admin/statements', {
      regenerate: () => ({
        status: 200,
        body: result({
          changed: false,
          after: { ...septemberFigures, version: 2 },
        }),
      }),
    });
    await screen.findByRole('region', { name: 'CNY 账单' });
    await userEvent.click(
      within(row('ABC001')).getByRole('button', { name: /重新生成 ABC001/ }),
    );
    await userEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', {
        name: '重新生成',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '账单与当前话单一致，没有变化（版本 2 不变），已记入操作日志',
    );
  });

  it('creates a missing statement with expected version 0 and no current figures', async () => {
    const { regenerations } = statementsApp('/admin/statements', {
      regenerate: () => ({
        status: 200,
        body: result({
          created: true,
          before: null,
          after: { ...septemberFigures, version: 1 },
        }),
      }),
    });
    await screen.findByRole('region', { name: 'CNY 账单' });
    await userEvent.click(
      within(row('NEW009')).getByRole('button', { name: /重新生成 NEW009/ }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: '重新生成 NEW009 2026年9月 账单？',
    });
    expect(dialog).toHaveTextContent('该月账单尚未生成');
    expect(dialog).not.toHaveTextContent('当前通话扣费');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '重新生成' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '已生成 NEW009 2026年9月 账单（版本 1），已记入操作日志',
    );
    expect(regenerations).toEqual([
      {
        path: `/api/admin/tenants/${fresh.id}/statements/2026-09/regenerate`,
        body: { expectedVersion: 0 },
      },
    ]);
  });

  it('refuses to submit again after a version conflict and refreshes the list', async () => {
    const { months } = statementsApp('/admin/statements', {
      regenerate: () => ({
        status: 409,
        body: apiError('STATEMENT_VERSION_CONFLICT'),
      }),
    });
    await screen.findByRole('region', { name: 'CNY 账单' });
    await userEvent.click(
      within(row('ABC001')).getByRole('button', { name: /重新生成 ABC001/ }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '重新生成' }),
    );
    expect(
      await within(dialog).findByText('账单已被重新生成，请刷新后重试'),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: '重新生成' }),
    ).toBeDisabled();
    await waitFor(() => expect(months.length).toBeGreaterThan(1));
    await userEvent.click(within(dialog).getByRole('button', { name: '刷新' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it.each([
    ['STATEMENT_DETAILS_DELETED', '该月话单已删除，无法重新生成账单'],
    ['STATEMENT_NOT_FINAL', '该月尚未结束，月结后才能重新生成账单'],
  ])(
    'shows the reason for %s and offers only to close',
    async (code, message) => {
      statementsApp('/admin/statements', {
        regenerate: () => ({ status: 409, body: apiError(code) }),
      });
      await screen.findByRole('region', { name: 'CNY 账单' });
      await userEvent.click(
        within(row('ABC001')).getByRole('button', { name: /重新生成 ABC001/ }),
      );
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(
        within(dialog).getByRole('button', { name: '重新生成' }),
      );
      expect(await within(dialog).findByText(message)).toBeVisible();
      expect(within(dialog).queryByRole('button', { name: '刷新' })).toBeNull();
      expect(
        within(dialog).getByRole('button', { name: '重新生成' }),
      ).toBeDisabled();
      await userEvent.click(
        within(dialog).getByRole('button', { name: '关闭' }),
      );
      expect(screen.queryByRole('dialog')).toBeNull();
    },
  );
});
