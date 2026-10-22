import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, apiError, renderApp } from '../../../test/app';
import {
  adminTenant,
  augustFigures,
  figures,
  finalRow,
  inProgressRow,
  pendingTenantRow,
  septemberFigures,
  statementTenantId as tenantId,
} from '../../../test/statements';

const downloadBlob = vi.hoisted(() =>
  vi.fn<(filename: string, blob: Blob) => void>(),
);
vi.mock('../../../lib/download', () => ({
  downloadBlob,
  downloadText: vi.fn(),
}));

const detailPath = `/api/admin/tenants/${tenantId}`;
const tenantDetail = {
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

const octoberFigures = figures({
  openingBalance: '-35.2',
  recharge: '0',
  gift: '0',
  adjustment: '0',
  callCharges: '42.1',
  closingBalance: '-77.3',
  calls: 20,
  callMinutes: '300',
});

function listBody(items: unknown[]) {
  return {
    currency: 'CNY',
    tenant: adminTenant,
    asOf: '2026-10-17T10:00:00.000Z',
    items,
  };
}

function detailBody(over: Record<string, unknown> = {}) {
  return {
    currency: 'CNY',
    tenant: adminTenant,
    month: '2026-08',
    state: 'final',
    period: { from: '2026-08-12', to: '2026-08-31', openedOn: '2026-08-12' },
    asOf: null,
    generatedAt: '2026-09-01T18:00:15.000Z',
    firstGeneratedAt: '2026-09-01T18:00:15.000Z',
    detailsDeleted: false,
    version: 1,
    generatedBy: null,
    reconcile: { status: 'unchecked', reconciledAt: null, diff: null },
    breakdownGap: '0',
    regenerable: { allowed: true, reason: null },
    figures: augustFigures,
    countries: [
      { country: '中国', calls: 7350, minutes: '28803', charge: '144.015' },
      { country: '牙买加', calls: 145, minutes: '700', charge: '17.5' },
      { country: '英国', calls: 212, minutes: '900', charge: '1.8' },
    ],
    days: [
      { day: '2026-08-12', calls: 100, minutes: '400', charge: '31.5' },
      { day: '2026-08-14', calls: 50, minutes: '200', charge: '10' },
    ],
    ...over,
  };
}

function tabApp(
  path: string,
  options: {
    items?: unknown[];
    detail?: Record<string, unknown>;
    exportReply?: { status: number; body?: unknown };
  } = {},
) {
  const downloads: { path: string; body: unknown }[] = [];
  const { handler } = adminApi({
    [`GET ${detailPath}`]: () => ({ status: 200, body: tenantDetail }),
    [`GET ${detailPath}/statements`]: () => ({
      status: 200,
      body: listBody(
        options.items ?? [
          inProgressRow('2026-10', octoberFigures),
          finalRow('2026-09', septemberFigures),
          finalRow('2026-08', augustFigures, {
            detailsDeleted: true,
            regenerable: { allowed: false, reason: 'details_deleted' },
          }),
        ],
      ),
    }),
    [`GET ${detailPath}/statements/2026-08`]: () => ({
      status: 200,
      body: detailBody(options.detail),
    }),
    [`POST ${detailPath}/statements/2026-08/export`]: (url, init) => {
      downloads.push({ path: url, body: JSON.parse(init.body as string) });
      return (
        options.exportReply ?? {
          status: 200,
          file: {
            text: '类别,项目\r\n',
            type: 'text/csv; charset=utf-8',
            disposition: 'attachment; filename="statement_ABC001.csv"',
          },
        }
      );
    },
    [`POST ${detailPath}/cdrs/export`]: (url, init) => {
      downloads.push({ path: url, body: JSON.parse(init.body as string) });
      return {
        status: 200,
        file: {
          text: 'cdr\r\n',
          type: 'text/csv; charset=utf-8',
          disposition: 'attachment; filename="cdrs_ABC001.csv"',
        },
      };
    },
  });
  return { downloads, ...renderApp(path, handler) };
}

beforeEach(() => {
  downloadBlob.mockClear();
  // 北京时间 2026-10-17 18:00。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const listPath = `/admin/tenants/${tenantId}?tab=statements`;
const detailUrl = `${listPath}&statementMonth=2026-08`;

describe('admin tenant statements list', () => {
  it('is the tab after CDRs and lists the months with the in-progress row disabled', async () => {
    tabApp(listPath);
    const nav = await screen.findByRole('navigation', { name: '租户详情' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['概况', '余额流水', '费率', '话单', '账单', '设置', '门户账号']);
    expect(within(nav).getByRole('link', { name: '账单' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const table = await screen.findByRole('table');
    const october = within(table).getByText('2026年10月').closest('tr')!;
    expect(october).toHaveTextContent('本月（进行中）');
    expect(october).toHaveTextContent('进行中，月结后可重新生成');
    expect(
      within(october).getByRole('button', { name: '重新生成 2026年10月' }),
    ).toBeDisabled();
    const september = within(table).getByText('2026年9月').closest('tr')!;
    expect(september).toHaveTextContent('-¥35.20');
    // 通话分钟数列带单位（租户详情稿 1f）。
    expect(september).toHaveTextContent('49,726分钟');
    // 期初为负也标红，与期末一致（上月期末为负的 10 月）。
    expect(within(october).getAllByText('-¥35.20')[0]).toHaveClass('text-neg');
    expect(
      within(september).getByRole('button', { name: '重新生成 2026年9月' }),
    ).toBeEnabled();
  });

  it('shows the compact phone card of the mockup: title row, one charge and minutes line, only the regenerate button', async () => {
    tabApp(listPath);
    await screen.findByRole('table');
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(3);
    const september = cards[1]!;
    expect(september).toHaveTextContent('2026年9月-¥35.20');
    expect(september).toHaveTextContent('通话扣费 ¥2,486.3049,726分钟');
    // 稿里没有「查看」按钮：月份本身是进入详情的链接，按钮只有「重新生成」。
    expect(within(september).getAllByRole('button')).toHaveLength(1);
    expect(
      within(september).getByRole('link', { name: '查看 2026年9月' }),
    ).toHaveAttribute(
      'href',
      expect.stringContaining('statementMonth=2026-09'),
    );
    // 进行中用小标签「进行中」，不可用的原因写在按钮旁。
    expect(cards[0]).toHaveTextContent('2026年10月进行中');
    expect(cards[0]).toHaveTextContent('进行中，月结后可重新生成');
    // 话单已删除：稿的手机卡片只写原因，没有标签。
    expect(cards[2]).toHaveTextContent('话单已删除，无法重新计算');
    expect(within(cards[2]!).queryByText('话单已删除')).not.toBeInTheDocument();
  });

  it('puts the 话单已删除 tag on the month line of the desktop table', async () => {
    tabApp(listPath);
    const table = await screen.findByRole('table');
    const monthLine = within(table)
      .getByText('2026年8月')
      .closest('div') as HTMLElement;
    expect(within(monthLine).getByText('话单已删除')).toBeVisible();
  });

  it('greys a month whose CDRs were deleted and says why', async () => {
    tabApp(listPath);
    const table = await screen.findByRole('table');
    const august = within(table).getByText('2026年8月').closest('tr')!;
    expect(august).toHaveTextContent('话单已删除');
    expect(august).toHaveTextContent('话单已删除，无法重新计算');
    expect(
      within(august).getByRole('button', { name: '重新生成 2026年8月' }),
    ).toBeDisabled();
    expect(
      screen.getByText(/2026年8月的话单明细已被删除，账单数据保留/),
    ).toBeVisible();
  });

  it('shows live figures for a month not generated yet and lets it be created', async () => {
    const created = {
      auditId: '00000000-0000-4000-8000-0000000000e1',
      month: '2026-09',
      created: true,
      changed: true,
      before: null,
      after: { ...septemberFigures, version: 1 },
      staleFollowingMonths: [],
    };
    const bodies: unknown[] = [];
    const { handler } = adminApi({
      [`GET ${detailPath}`]: () => ({ status: 200, body: tenantDetail }),
      [`GET ${detailPath}/statements`]: () => ({
        status: 200,
        body: listBody([pendingTenantRow('2026-09', septemberFigures)]),
      }),
      [`POST ${detailPath}/statements/2026-09/regenerate`]: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return { status: 200, body: created };
      },
    });
    renderApp(listPath, handler);
    const row = within(await screen.findByRole('table'))
      .getByText('2026年9月')
      .closest('tr')!;
    expect(row).toHaveTextContent('待生成');
    expect(row).toHaveTextContent('-¥35.20');
    await userEvent.click(
      within(row).getByRole('button', { name: '重新生成 2026年9月' }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('该月账单尚未生成');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '重新生成' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      '已生成 ABC001 2026年9月 账单（版本 1）',
    );
    expect(bodies).toEqual([{ expectedVersion: 0 }]);
  });

  it('shows the stale and inconsistent notes under the month', async () => {
    tabApp(listPath, {
      items: [
        finalRow('2026-09', septemberFigures, { reconcileStatus: 'stale' }),
        finalRow('2026-08', augustFigures, { reconcileStatus: 'inconsistent' }),
      ],
    });
    const table = await screen.findByRole('table');
    expect(
      within(table).getByText('2026年9月').closest('tr'),
    ).toHaveTextContent('账单已过期');
    expect(
      within(table).getByText('2026年8月').closest('tr'),
    ).toHaveTextContent('账单与流水不一致');
  });

  it('opens a month from its view link and returns with the tab link', async () => {
    const { location } = tabApp(listPath);
    const table = await screen.findByRole('table');
    expect(
      within(table).getByRole('link', { name: '查看 2026年8月' }),
    ).toHaveAttribute('href', `${listPath}&statementMonth=2026-08`);
    await userEvent.click(
      within(table).getByRole('link', { name: '查看 2026年8月' }),
    );
    expect(await screen.findByText('‹ 返回账单列表')).toBeVisible();
    expect(location()).toBe(detailUrl);
    await userEvent.click(
      within(screen.getByRole('navigation', { name: '租户详情' })).getByRole(
        'link',
        { name: '账单' },
      ),
    );
    expect(await screen.findByRole('table')).toBeVisible();
    expect(location()).toBe(listPath);
  });

  it('keeps the statement month out of the other tabs', async () => {
    const { location } = tabApp(detailUrl);
    await screen.findByText('‹ 返回账单列表');
    await userEvent.click(
      within(screen.getByRole('navigation', { name: '租户详情' })).getByRole(
        'link',
        { name: '余额流水' },
      ),
    );
    await waitFor(() =>
      expect(location()).toBe(`/admin/tenants/${tenantId}?tab=ledger`),
    );
  });
});

describe('admin statement detail', () => {
  it('shows the opening-date period, the equation and the admin facts', async () => {
    tabApp(detailUrl, {
      detail: {
        version: 2,
        firstGeneratedAt: '2026-09-01T18:00:15.000Z',
        generatedAt: '2026-10-02T03:04:05.000Z',
        generatedBy: {
          id: '00000000-0000-4000-8000-0000000000b2',
          name: '王敏',
        },
        reconcile: {
          status: 'stale',
          reconciledAt: '2026-10-03T18:30:00.000Z',
          diff: '12.5',
        },
      },
    });
    expect(
      await screen.findByRole('heading', { name: '2026年8月' }),
    ).toBeVisible();
    expect(screen.getByText('2026-08-12（开户）至 2026-08-31')).toBeVisible();
    expect(screen.getByText('账单生成于 2026-10-02 11:04:05')).toBeVisible();
    const summary = screen.getByRole('region', { name: '账单汇总' });
    expect(summary).toHaveTextContent('¥3,000.00');
    expect(summary).toHaveTextContent('¥1,873.40');
    expect(summary).toHaveTextContent('9,642 通 · 37,468分钟');
    expect(summary).toHaveTextContent('¥1,176.60');
    const facts = screen.getByLabelText('账单信息');
    expect(facts).toHaveTextContent('v2（首次生成 2026-09-02 02:00:15）');
    expect(facts).toHaveTextContent('王敏');
    expect(facts).toHaveTextContent('账单已过期');
    expect(facts).toHaveTextContent('¥12.50');
  });

  it('names the scheduled job when no administrator generated the statement', async () => {
    tabApp(detailUrl);
    await screen.findByRole('heading', { name: '2026年8月' });
    const facts = screen.getByLabelText('账单信息');
    expect(facts).toHaveTextContent('系统（定时任务）');
    expect(facts).toHaveTextContent('尚未核对');
  });

  it('shows each country with its share, summing the rows in the total row', async () => {
    tabApp(detailUrl);
    const countries = await screen.findByRole('region', {
      name: '按国家汇总',
    });
    const china = within(countries)
      .getByRole('cell', { name: '中国' })
      .closest('tr')!;
    // 144.015 / 163.315
    expect(china).toHaveTextContent('88.2%');
    expect(china).toHaveTextContent('7,350');
    expect(china).toHaveTextContent('28,803分钟');
    const total = within(countries)
      .getByText('合计', { selector: 'td' })
      .closest('tr')!;
    expect(total).toHaveTextContent('7,707');
    expect(total).toHaveTextContent('¥163.32');
  });

  it('fills days without calls with zero from the opening date', async () => {
    tabApp(detailUrl);
    const days = await screen.findByRole('region', { name: '按日汇总' });
    expect(days).toHaveTextContent('20 天');
    const rows = within(days)
      .getAllByRole('row')
      .filter((row) => /^2026-08-/.test(row.textContent ?? ''));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toHaveTextContent('2026-08-12');
    expect(rows[0]).toHaveTextContent('¥31.50');
    expect(rows[1]).toHaveTextContent('2026-08-1300分钟¥0.00');
    expect(rows[2]).toHaveTextContent('2026-08-14');
  });

  it('notes a breakdown gap between the header and the call detail', async () => {
    tabApp(detailUrl, { detail: { breakdownGap: '1240.75' } });
    const facts = await screen.findByLabelText('账单信息');
    expect(facts).toHaveTextContent('话单明细与通话扣费相差 ¥1,240.75');
    // 国家表与日表的共用说明（部分扣费没有对应的话单明细）。
    expect(screen.getAllByText('部分扣费没有对应的话单明细')).toHaveLength(2);
  });

  it('has no gap line in the info block when breakdownGap is zero', async () => {
    tabApp(detailUrl);
    await screen.findByRole('heading', { name: '2026年8月' });
    expect(screen.queryByText(/话单明细与通话扣费相差/)).toBeNull();
  });

  it('exports the summary and the month CDRs', async () => {
    const { downloads } = tabApp(detailUrl);
    await screen.findByRole('heading', { name: '2026年8月' });
    await userEvent.click(
      screen.getByRole('button', { name: '导出 CSV（汇总）' }),
    );
    await waitFor(() =>
      expect(downloadBlob).toHaveBeenCalledWith(
        'statement_ABC001.csv',
        expect.anything(),
      ),
    );
    await userEvent.click(
      screen.getByRole('button', { name: '导出 CSV（该月话单明细）' }),
    );
    await waitFor(() =>
      expect(downloadBlob).toHaveBeenCalledWith(
        'cdrs_ABC001.csv',
        expect.anything(),
      ),
    );
    expect(downloads).toEqual([
      { path: `${detailPath}/statements/2026-08/export`, body: {} },
      {
        path: `${detailPath}/cdrs/export`,
        body: {
          from: '2026-08-01',
          to: '2026-08-31',
          status: 'answered',
          unverifiedOnly: false,
        },
      },
    ]);
  });

  it('disables the CDR export and regeneration for a month whose CDRs were deleted', async () => {
    tabApp(detailUrl, {
      detail: {
        detailsDeleted: true,
        regenerable: { allowed: false, reason: 'details_deleted' },
      },
    });
    expect(await screen.findByText('该月话单明细已删除')).toBeVisible();
    const detailExport = screen.getByRole('button', {
      name: '导出 CSV（该月话单明细）',
    });
    expect(detailExport).toBeDisabled();
    expect(detailExport).toHaveAttribute('title', '该月话单明细已删除');
    expect(
      screen.getByRole('button', { name: '导出 CSV（汇总）' }),
    ).toBeEnabled();
    expect(
      screen.getByRole('button', { name: '重新生成 2026年8月' }),
    ).toBeDisabled();
    expect(screen.getByText('话单已删除，无法重新计算')).toBeVisible();
  });

  it('says the month is in progress and cannot be regenerated yet', async () => {
    const inProgress = {
      state: 'in_progress',
      month: '2026-08',
      generatedAt: null,
      firstGeneratedAt: null,
      asOf: '2026-10-17T10:00:03.000Z',
      version: 0,
      reconcile: null,
      period: { from: '2026-08-01', to: '2026-08-17', openedOn: null },
      regenerable: { allowed: false, reason: 'in_progress' },
    };
    tabApp(detailUrl, { detail: inProgress });
    expect(
      await screen.findByText(
        '本月尚未结束，以下数据截至今日并实时更新；2026-09-01 凌晨生成正式账单。',
      ),
    ).toBeVisible();
    expect(
      screen.getByText('数据截至 2026-10-17 18:00:03 · 实时计算'),
    ).toBeVisible();
    expect(screen.getByText('进行中，月结后可重新生成')).toBeVisible();
    expect(
      screen.getByRole('button', { name: '重新生成 2026年8月' }),
    ).toBeDisabled();
    expect(screen.getAllByText('今日 · 截至当前').length).toBeGreaterThan(0);
  });

  it('prints with the browser print dialog', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    tabApp(detailUrl);
    await screen.findByRole('heading', { name: '2026年8月' });
    await userEvent.click(screen.getByRole('button', { name: '打印' }));
    expect(print).toHaveBeenCalledOnce();
  });

  it('regenerates from the detail with the version it shows', async () => {
    const bodies: unknown[] = [];
    const { handler } = adminApi({
      [`GET ${detailPath}`]: () => ({ status: 200, body: tenantDetail }),
      [`GET ${detailPath}/statements/2026-08`]: () => ({
        status: 200,
        body: detailBody({ version: 3 }),
      }),
      [`POST ${detailPath}/statements/2026-08/regenerate`]: (_url, init) => {
        bodies.push(JSON.parse(init.body as string));
        return { status: 409, body: apiError('STATEMENT_VERSION_CONFLICT') };
      },
    });
    renderApp(detailUrl, handler);
    await userEvent.click(
      await screen.findByRole('button', { name: '重新生成 2026年8月' }),
    );
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(
      within(dialog).getByRole('button', { name: '重新生成' }),
    );
    expect(
      await within(dialog).findByText('账单已被重新生成，请刷新后重试'),
    ).toBeVisible();
    expect(bodies).toEqual([{ expectedVersion: 3 }]);
  });

  it('explains a month that does not exist', async () => {
    const { handler } = adminApi({
      [`GET ${detailPath}`]: () => ({ status: 200, body: tenantDetail }),
      [`GET ${detailPath}/statements/2026-08`]: () => ({
        status: 404,
        body: apiError('NOT_FOUND'),
      }),
    });
    renderApp(detailUrl, handler);
    expect(await screen.findByText('账单加载失败')).toBeVisible();
    expect(screen.getByText('内容不存在或已被删除')).toBeVisible();
  });
});
