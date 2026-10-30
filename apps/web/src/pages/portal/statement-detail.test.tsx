import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PortalStatementResponse } from '@fs-billing/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiry } from '../../lib/session';
import { apiError, customerSession, renderApp } from '../../test/app';
import { augustDetail, septemberDetail } from '../../test/portal-statements';

const downloadBlob = vi.hoisted(() =>
  vi.fn<(filename: string, blob: Blob) => void>(),
);
vi.mock('../../lib/download', () => ({ downloadBlob, downloadText: vi.fn() }));

beforeEach(() => {
  downloadBlob.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
});

type Reply = { status: number; body?: unknown };

function renderDetail(
  month: string,
  statement: PortalStatementResponse | Reply,
) {
  const requests: { path: string; method: string; body: unknown }[] = [];
  const app = renderApp(`/portal/statements/${month}`, (path, init) => {
    requests.push({
      path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (path === '/api/auth/session')
      return { status: 200, body: customerSession };
    if (path === `/api/portal/statements/${month}`)
      return 'status' in statement
        ? statement
        : { status: 200, body: statement };
    if (
      path === `/api/portal/statements/${month}/export` ||
      path === '/api/portal/cdrs/export'
    )
      return {
        status: 200,
        file: {
          text: 'csv',
          type: 'text/csv; charset=utf-8',
          disposition: 'attachment; filename="statement_ABC001.csv"',
        },
      };
    throw new Error(`unexpected ${path}`);
  });
  return { ...app, requests };
}

/** 电脑表格与手机卡片都在文档里，测试取电脑那一份。 */
async function desktopTable(name: string) {
  const section = await screen.findByRole('region', { name });
  return within(section).getByRole('table');
}

describe('portal statement detail', () => {
  it('shows the August equation of the mockup: 0 + 3,000 + 50 ± 0 − 1,873.40 = 1,176.60', async () => {
    renderDetail('2026-08', augustDetail);
    const equation = await screen.findByRole('region', { name: '账单汇总' });
    const desktop = equation.firstElementChild as HTMLElement;
    expect(desktop).toHaveTextContent(
      '期初余额¥0.00+充值¥3,000.00+赠送¥50.00±调账¥0.00−通话扣费¥1,873.409,642 通 · 37,468分钟=期末余额¥1,176.60',
    );
    expect(
      screen.getByRole('heading', { name: '2026年8月' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('深圳市某某科技有限公司')[0]).toBeVisible();
    expect(screen.getByText('ABC001').parentElement).toHaveTextContent(
      '深圳市某某科技有限公司ABC001币种 CNY2026-08-12（开户）至 2026-08-31',
    );
    expect(screen.getAllByText(/账单生成于/)[0]).toHaveTextContent(
      '账单生成于 2026-09-01 02:00:15',
    );
    expect(screen.queryByText('本月（进行中）')).toBeNull();
  });

  it('uses a stacked equation and tables until the wide layout fits', async () => {
    renderDetail('2026-09', septemberDetail);
    const equation = await screen.findByRole('region', { name: '账单汇总' });
    expect(equation.children[0]).toHaveClass('hidden', 'xl:flex');
    expect(equation.children[0]).not.toHaveClass('overflow-x-auto');
    expect(equation.children[1]).toHaveClass('flex', 'xl:hidden');
    const countries = screen.getByRole('region', { name: '按国家汇总' });
    const days = screen.getByRole('region', { name: '按日汇总' });
    expect(countries.parentElement).toBe(days.parentElement);
    expect(countries.parentElement).toHaveClass('grid', 'xl:grid-cols-2');
    expect(within(countries).getByRole('table')).toHaveClass(
      'whitespace-nowrap',
    );
    expect(within(days).getByRole('table')).toHaveClass('whitespace-nowrap');
    expect(screen.getByRole('heading', { name: '2026年9月' })).toHaveClass(
      'whitespace-nowrap',
    );
  });

  it('shows the September equation with negative adjustment and closing in red', async () => {
    renderDetail('2026-09', septemberDetail);
    const equation = await screen.findByRole('region', { name: '账单汇总' });
    const desktop = equation.firstElementChild as HTMLElement;
    expect(desktop).toHaveTextContent(
      '期初余额¥1,176.60+充值¥1,300.00+赠送¥0.00±调账-¥25.50−通话扣费¥2,486.3012,804 通 · 49,726分钟=期末余额-¥35.20',
    );
    const operators = desktop.querySelectorAll('[aria-hidden="true"]');
    expect(operators).toHaveLength(5);
    const amount = within(desktop).getByText('¥2,486.30').parentElement;
    for (const operator of operators) {
      expect(operator).toHaveClass('flex', 'flex-col', 'gap-1.5');
      expect(operator.firstElementChild).toHaveClass(
        'invisible',
        'text-[13px]',
      );
      expect(operator.lastElementChild).toHaveClass(
        'text-[22px]',
        'leading-normal',
      );
      expect(amount).toHaveClass('text-[22px]', 'leading-normal');
    }
    expect(within(desktop).getByText('12,804 通 · 49,726分钟')).toHaveClass(
      'whitespace-nowrap',
    );
    expect(within(desktop).getByText('-¥25.50')).toHaveClass('text-neg');
    expect(within(desktop).getByText('-¥35.20')).toHaveClass('text-neg');
    expect(within(desktop).getByText('¥1,300.00')).not.toHaveClass('text-neg');
  });

  it('shows the live month marks and the generation notice', async () => {
    renderDetail('2026-09', septemberDetail);
    await screen.findByRole('region', { name: '账单汇总' });
    expect(screen.getAllByText('本月（进行中）').length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        '本月尚未结束，以下数据截至今日并实时更新；2026-10-01 凌晨生成正式账单。',
      ),
    ).toBeVisible();
    expect(screen.getByText('ABC001').parentElement).toHaveTextContent(
      '2026-09-01 至 2026-09-29（进行中）',
    );
    expect(screen.getAllByText(/数据截至/)[0]).toHaveTextContent(
      '数据截至 2026-09-29 14:03:22 · 实时更新',
    );
  });

  it("shows each country's share of the call charges, one row per country", async () => {
    renderDetail('2026-08', augustDetail);
    const table = await desktopTable('按国家汇总');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['国家', '通话数', '计费分钟', '占比', '费用']);
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(10);
    expect(rows[1]).toHaveTextContent('中国7,35028,803分钟76.9%¥1,440.15');
    expect(rows[2]).toHaveTextContent('牙买加145700分钟9.3%¥175.00');
    expect(rows[8]).toHaveTextContent('美国/加拿大113465分钟0.2%¥4.65');
    // 英国手机并入国家，不出现「国家/备注」列头。
    expect(within(table).queryByText('国家/备注')).toBeNull();
    expect(rows[9]).toHaveTextContent('合计9,64237,468分钟¥1,873.40');
  });

  it('fills days without calls with zero from the opening date', async () => {
    renderDetail('2026-08', augustDetail);
    const table = await desktopTable('按日汇总');
    const rows = within(table).getAllByRole('row').slice(1, -1);
    expect(rows).toHaveLength(20);
    expect(rows[0]).toHaveTextContent('2026-08-12120630分钟¥31.50');
    expect(rows[1]).toHaveTextContent('2026-08-1300分钟¥0.00');
    expect(rows.map((row) => row.firstChild?.textContent)).toEqual(
      Array.from({ length: 20 }, (_, index) => `2026-08-${12 + index}`),
    );
    expect(rows.at(-1)).toHaveTextContent('2026-08-319,042');
    expect(within(table).getAllByRole('row').at(-1)).toHaveTextContent(
      '合计9,64237,468分钟¥1,873.40',
    );
  });

  it('titles the table with the period length', async () => {
    renderDetail('2026-08', augustDetail);
    const august = await screen.findByRole('region', { name: '按日汇总' });
    expect(august).toHaveTextContent('按日汇总20 天');
  });

  it('counts the days up to today for the live month and marks today', async () => {
    renderDetail('2026-09', septemberDetail);
    const section = await screen.findByRole('region', { name: '按日汇总' });
    expect(section).toHaveTextContent('按日汇总29 天');
    const table = within(section).getByRole('table');
    expect(within(table).getAllByRole('row').slice(1, -1)).toHaveLength(29);
    const today = within(table).getAllByRole('row').at(-2);
    expect(today).toHaveTextContent('2026-09-29今日 · 截至当前');
    expect(within(table).getAllByText('今日 · 截至当前')).toHaveLength(1);
  });

  describe('when the ledger charge differs from the CDR breakdown', () => {
    // 头部通话扣费来自流水 1,000.00；国家与日明细来自话单，各行合计 1,873.40。
    const gap = {
      ...augustDetail,
      figures: {
        ...augustDetail.figures,
        callCharges: '1000',
        closingBalance: '2050',
      },
    };

    it('sums the rows in the totals and shares, and notes the gap under each table', async () => {
      renderDetail('2026-08', gap);
      const countries = await desktopTable('按国家汇总');
      const rows = within(countries).getAllByRole('row');
      // 合计是各行之和，占比以各行之和为分母。
      expect(rows.at(-1)).toHaveTextContent('合计9,64237,468分钟¥1,873.40');
      expect(rows[1]).toHaveTextContent('76.9%');
      const shares = rows
        .slice(1, -1)
        .map((row) =>
          Number.parseFloat(within(row).getAllByRole('cell')[3]!.textContent),
        );
      expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(100, 0);
      const days = await desktopTable('按日汇总');
      expect(within(days).getAllByRole('row').at(-1)).toHaveTextContent(
        '合计9,64237,468分钟¥1,873.40',
      );
      expect(screen.getAllByText('部分扣费没有对应的话单明细')).toHaveLength(2);
      // 头部算式仍来自流水。
      const equation = screen.getByRole('region', { name: '账单汇总' });
      expect(equation.firstElementChild).toHaveTextContent('通话扣费¥1,000.00');
    });

    it('notes a month whose breakdown is empty and sums to zero', async () => {
      renderDetail('2026-08', { ...gap, countries: [], days: [] });
      const countries = await desktopTable('按国家汇总');
      expect(within(countries).getAllByRole('row').at(-1)).toHaveTextContent(
        '合计00分钟¥0.00',
      );
      expect(screen.getAllByText('部分扣费没有对应的话单明细')).toHaveLength(2);
    });

    it('shows no note when the breakdown adds up to the header', async () => {
      renderDetail('2026-08', augustDetail);
      await desktopTable('按国家汇总');
      expect(screen.queryByText('部分扣费没有对应的话单明细')).toBeNull();
    });

    it('compares decimal strings exactly', async () => {
      // 0.1 + 0.2 = 0.3：浮点相加会误报差额。
      const exact = {
        ...augustDetail,
        figures: {
          ...augustDetail.figures,
          callCharges: '0.3',
          closingBalance: '3049.7',
        },
        countries: [
          { country: '中国', calls: 1, minutes: '1', charge: '0.1' },
          { country: '日本', calls: 1, minutes: '1', charge: '0.2' },
        ],
        days: [{ day: '2026-08-12', calls: 2, minutes: '2', charge: '0.3' }],
      };
      renderDetail('2026-08', exact);
      await desktopTable('按国家汇总');
      expect(screen.queryByText('部分扣费没有对应的话单明细')).toBeNull();
    });
  });

  it('exports the summary CSV for the month and saves the file', async () => {
    const user = userEvent.setup();
    const { requests } = renderDetail('2026-09', septemberDetail);
    await screen.findByRole('region', { name: '账单汇总' });
    await user.click(
      screen.getAllByRole('button', { name: '导出 CSV（汇总）' })[0]!,
    );
    await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(downloadBlob.mock.calls[0]?.[0]).toBe('statement_ABC001.csv');
    expect(requests.at(-1)).toEqual({
      path: '/api/portal/statements/2026-09/export',
      method: 'POST',
      body: {},
    });
  });

  it('exports the answered CDRs of the whole calendar month', async () => {
    const user = userEvent.setup();
    const { requests } = renderDetail('2026-09', septemberDetail);
    await screen.findByRole('region', { name: '账单汇总' });
    await user.click(
      screen.getAllByRole('button', { name: '导出 CSV（该月话单明细）' })[0]!,
    );
    await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(requests.at(-1)).toEqual({
      path: '/api/portal/cdrs/export',
      method: 'POST',
      // 状态缺省为已接通，行数与账单的通话数一致。
      body: { from: '2026-09-01', to: '2026-09-30', status: 'answered' },
    });
  });

  it('disables the CDR export and says why when the month CDRs were deleted', async () => {
    renderDetail('2026-08', { ...augustDetail, detailsDeleted: true });
    await screen.findByRole('region', { name: '账单汇总' });
    for (const button of screen.getAllByRole('button', {
      name: '导出 CSV（该月话单明细）',
    }))
      expect(button).toBeDisabled();
    expect(
      screen.getByText('账单汇总不受影响，但无法再导出该月话单明细。'),
    ).toBeInTheDocument();
    expect(screen.getAllByText('该月话单明细已删除')[0]).toBeVisible();
    // 汇总仍可导出。
    for (const button of screen.getAllByRole('button', {
      name: '导出 CSV（汇总）',
    }))
      expect(button).toBeEnabled();
  });

  it('prints the page from the print button', async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    renderDetail('2026-09', septemberDetail);
    await screen.findByRole('region', { name: '账单汇总' });
    await user.click(screen.getAllByRole('button', { name: '打印' })[0]!);
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('prints from the ⋯ menu on the phone', async () => {
    const user = userEvent.setup();
    const print = vi.fn();
    vi.stubGlobal('print', print);
    renderDetail('2026-09', septemberDetail);
    await screen.findByRole('region', { name: '账单汇总' });
    await user.click(screen.getByRole('button', { name: '更多操作' }));
    const dialog = await screen.findByRole('dialog', { name: '更多操作' });
    await user.click(within(dialog).getByRole('button', { name: '打印' }));
    await vi.waitFor(() => expect(print).toHaveBeenCalledTimes(1));
  });

  it('shows an export failure with a retry', async () => {
    const user = userEvent.setup();
    let failing = true;
    renderApp('/portal/statements/2026-09', (path) => {
      if (path === '/api/auth/session')
        return { status: 200, body: customerSession };
      if (path === '/api/portal/statements/2026-09')
        return { status: 200, body: septemberDetail };
      if (path === '/api/portal/statements/2026-09/export')
        return failing
          ? { status: 500, body: apiError('INTERNAL_ERROR') }
          : {
              status: 200,
              file: { text: 'csv', type: 'text/csv; charset=utf-8' },
            };
      throw new Error(`unexpected ${path}`);
    });
    await screen.findByRole('region', { name: '账单汇总' });
    await user.click(
      screen.getAllByRole('button', { name: '导出 CSV（汇总）' })[0]!,
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('导出失败');
    failing = false;
    await user.click(within(alert).getByRole('button', { name: '重试' }));
    await vi.waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
  });

  it('labels a finished month that has no statement row yet', async () => {
    renderDetail('2026-08', {
      ...augustDetail,
      state: 'pending',
      generatedAt: null,
      asOf: '2026-09-01T16:10:00.000Z',
    });
    await screen.findByRole('region', { name: '账单汇总' });
    expect(screen.getAllByText('待生成')[0]).toBeVisible();
    expect(
      screen.getByText('该月已结束，正式账单尚未生成；以下数据为实时计算。'),
    ).toBeVisible();
  });

  it('shows no billing internals in the page', async () => {
    renderDetail('2026-08', augustDetail);
    await screen.findByRole('region', { name: '账单汇总' });
    for (const word of ['版本', '核对', '差额', '未经验证'])
      expect(document.body).not.toHaveTextContent(word);
  });

  it('says so when the month is not found and links back to the list', async () => {
    renderDetail('2026-01', {
      status: 404,
      body: apiError('NOT_FOUND'),
    });
    expect(await screen.findByText('月账单加载失败')).toBeVisible();
    expect(screen.getByText('内容不存在或已被删除')).toBeVisible();
    for (const link of screen.getAllByRole('link', { name: '返回月账单' }))
      expect(link).toHaveAttribute('href', '/portal/statements');
  });

  it('treats a malformed month in the address as a missing page without a request', async () => {
    const { requests } = renderDetail('2026-13', septemberDetail);
    expect(
      await screen.findByRole('heading', { name: '找不到这个页面' }),
    ).toBeVisible();
    expect(requests.map((request) => request.path)).not.toContain(
      '/api/portal/statements/2026-13',
    );
  });
});
