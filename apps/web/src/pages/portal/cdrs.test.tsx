import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, customerSession, renderApp } from '../../test/app';
import { answeredCdr, cdrList, unansweredCdr } from '../../test/cdr';

const downloadBlob = vi.hoisted(() =>
  vi.fn<(filename: string, blob: Blob) => void>(),
);
vi.mock('../../lib/download', () => ({ downloadBlob, downloadText: vi.fn() }));

const listPath = '/api/portal/cdrs';

type Handler = (url: string) => { status: number; body?: unknown };

function cdrApp(
  path: string,
  {
    list = () => ({ status: 200, body: cdrList([answeredCdr()]) }),
    exportReply,
  }: {
    list?: Handler;
    exportReply?: () => ReturnType<Handler> & {
      file?: { text: string; type: string; disposition?: string };
    };
  } = {},
) {
  const lists: URLSearchParams[] = [];
  const countries: URLSearchParams[] = [];
  const exports: unknown[] = [];
  const { handler } = adminApi(
    {
      [`GET ${listPath}`]: (url) => {
        lists.push(new URL(url, 'http://localhost').searchParams);
        return list(url);
      },
      [`GET ${listPath}/countries`]: (url) => {
        countries.push(new URL(url, 'http://localhost').searchParams);
        return {
          status: 200,
          body: { countries: ['英国', '中国', '牙买加'] },
        };
      },
      [`POST ${listPath}/export`]: (_url, init) => {
        exports.push(JSON.parse(init.body as string));
        return (
          exportReply?.() ?? {
            status: 200,
            file: {
              text: 'csv',
              type: 'text/csv; charset=utf-8',
              disposition:
                'attachment; filename="cdrs_ABC001_2026-10-01_2026-10-17.csv"',
            },
          }
        );
      },
    },
    customerSession,
  );
  return { lists, countries, exports, ...renderApp(path, handler) };
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
});

const table = () => screen.getByRole('table');

describe('portal CDR list', () => {
  it('lists the answered calls of the current month with the merged country label', async () => {
    const { lists, countries, location } = cdrApp('/portal/cdrs');
    await within(await screen.findByRole('table')).findByText('英国 · 手机');
    expect(Object.fromEntries(lists.at(-1)!)).toEqual({
      from: '2026-10-01',
      to: '2026-10-17',
      status: 'answered',
      page: '1',
    });
    expect(Object.fromEntries(countries.at(-1)!)).toEqual({
      from: '2026-10-01',
      to: '2026-10-17',
    });
    expect(location()).toBe('/portal/cdrs');
    const headers = within(table())
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toEqual([
      '接通时间 ↓',
      '主叫号码',
      '被叫号码',
      '国家',
      '通话时长',
      '计费时长',
      '费率（元/分钟）',
      '费用',
    ]);
    const row = within(table()).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('2026-10-16 18:00:00');
    expect(row).toHaveTextContent('+447700900123');
    expect(row).toHaveTextContent('3分50秒');
    expect(row).toHaveTextContent('4分钟');
    expect(row).toHaveTextContent('0.0450');
    expect(row).toHaveTextContent('¥0.18');
  });

  it('shows only the country when the rate has no description, and never the ISO code', async () => {
    cdrApp('/portal/cdrs', {
      list: () => ({
        status: 200,
        body: cdrList([answeredCdr(1, { description: null })]),
      }),
    });
    const cell = await within(await screen.findByRole('table')).findByText(
      '英国',
    );
    expect(cell).toHaveTextContent(/^英国$/);
    expect(screen.queryByText('GB')).toBeNull();
  });

  it('shows 00:30 on the 29th for a call answered at 16:30 UTC on the 28th', async () => {
    cdrApp('/portal/cdrs?from=2026-09-29&to=2026-09-29', {
      list: () => ({
        status: 200,
        body: cdrList([
          answeredCdr(1, {
            startedAt: '2026-09-28T16:29:50.000Z',
            answeredAt: '2026-09-28T16:30:00.000Z',
            endedAt: '2026-09-28T16:33:50.000Z',
          }),
        ]),
      }),
    });
    expect(
      await within(await screen.findByRole('table')).findByText(
        '2026-09-29 00:30:00',
      ),
    ).toBeVisible();
  });

  it('sends the address filters, normalizes the callee and writes the filters to the address', async () => {
    const user = userEvent.setup();
    const { lists, countries, location } = cdrApp('/portal/cdrs');
    await screen.findByRole('table');
    await user.type(
      screen.getByRole('searchbox', { name: '被叫号码' }),
      '+44 7700 900123',
    );
    await waitFor(() => expect(location()).toContain('callee='));
    await waitFor(() =>
      expect(Object.fromEntries(lists.at(-1)!)).toMatchObject({
        callee: '447700900123',
      }),
    );
    await user.selectOptions(
      await screen.findByRole('combobox', { name: '国家' }),
      '牙买加',
    );
    await user.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() =>
      expect(Object.fromEntries(lists.at(-1)!)).toEqual({
        from: '2026-10-01',
        to: '2026-10-17',
        callee: '447700900123',
        country: '牙买加',
        status: 'all',
        page: '1',
      }),
    );
    expect(location()).toContain('country=%E7%89%99%E4%B9%B0%E5%8A%A0');
    expect(location()).toContain('status=all');
    // 国家选项只随日期范围变化，不带被叫号码与状态。
    expect(Object.fromEntries(countries.at(-1)!)).toEqual({
      from: '2026-10-01',
      to: '2026-10-17',
    });
    // 国家下拉只列国家，不含说明。
    const options = within(
      screen.getByRole('combobox', { name: '国家' }),
    ).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '全部国家',
      '英国',
      '中国',
      '牙买加',
    ]);
  });

  it('restores the filters from the address after a reload', async () => {
    const { lists } = cdrApp(
      '/portal/cdrs?from=2026-09-01&to=2026-09-29&country=%E8%8B%B1%E5%9B%BD&status=all&callee=%22447%22&page=2',
    );
    await screen.findByRole('table');
    expect(Object.fromEntries(lists.at(-1)!)).toEqual({
      from: '2026-09-01',
      to: '2026-09-29',
      callee: '447',
      country: '英国',
      status: 'all',
      page: '2',
    });
    expect(screen.getByRole('searchbox', { name: '被叫号码' })).toHaveValue(
      '447',
    );
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('reads a numeric callee from the address as text', async () => {
    const { lists } = cdrApp('/portal/cdrs?callee=447');
    await screen.findByRole('table');
    expect(lists.at(-1)!.get('callee')).toBe('447');
  });

  it('drops malformed address parameters without clearing the valid ones', async () => {
    const { lists } = cdrApp(
      '/portal/cdrs?from=bad&to=2026-10-10&status=bogus&page=abc&country=%E8%8B%B1%E5%9B%BD',
    );
    await screen.findByRole('table');
    expect(Object.fromEntries(lists.at(-1)!)).toEqual({
      from: '2026-10-01',
      to: '2026-10-10',
      country: '英国',
      status: 'answered',
      page: '1',
    });
  });

  it('does not request a callee search that the API would reject, and says why', async () => {
    const { lists, countries } = cdrApp('/portal/cdrs?callee=%22abc%22');
    expect(
      await screen.findByText('被叫号码只能包含数字、+、空格、连字符和括号'),
    ).toBeVisible();
    expect(lists).toHaveLength(0);
    expect(countries).toHaveLength(1);
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.getByRole('button', { name: '导出 CSV（当前筛选）' }),
    ).toBeDisabled();
  });

  it('does not request a range over one month and names the latest end date', async () => {
    const { lists, countries } = cdrApp(
      '/portal/cdrs?from=2026-09-01&to=2026-10-01',
    );
    expect(await screen.findByText(/日期范围超出一个月上限/)).toHaveTextContent(
      '结束日期不能晚于 2026-09-30',
    );
    expect(lists).toHaveLength(0);
    expect(countries).toHaveLength(0);
  });

  it('notes the hidden unanswered calls in the answered view and counts them in the all view', async () => {
    const { lists } = cdrApp('/portal/cdrs', {
      list: (url) =>
        new URL(url, 'http://localhost').searchParams.get('status') === 'all'
          ? {
              status: 200,
              body: cdrList([answeredCdr(), unansweredCdr()], {
                unansweredCalls: 713,
                total: 13517,
              }),
            }
          : {
              status: 200,
              body: cdrList([answeredCdr()], {
                unansweredCalls: 713,
                total: 12804,
                billedMinutes: '49726',
                charge: '2486.3',
              }),
            },
    });
    const user = userEvent.setup();
    const summary = (
      await screen.findAllByRole('region', { name: '汇总' })
    )[0]!;
    expect(summary).toHaveTextContent('通话数12,804');
    expect(summary).toHaveTextContent('另有未接通 713 通');
    expect(summary).toHaveTextContent('49,726分钟');
    expect(summary).toHaveTextContent('¥2,486.30');
    await user.click(screen.getByRole('button', { name: '全部' }));
    await waitFor(() => expect(lists.at(-1)!.get('status')).toBe('all'));
    await waitFor(() =>
      expect(
        screen.getAllByRole('region', { name: '汇总' })[0],
      ).toHaveTextContent('含未接通 713'),
    );
    const unanswered = within(table())
      .getAllByRole('row')
      .find((row) => within(row).queryByText('未接通'));
    expect(unanswered).toHaveClass('text-muted-foreground');
    expect(unanswered).toHaveTextContent('¥0.00');
  });

  it('pages through the server pages with a range caption', async () => {
    const user = userEvent.setup();
    const { lists, location } = cdrApp('/portal/cdrs', {
      list: (url) => {
        const page = Number(
          new URL(url, 'http://localhost').searchParams.get('page'),
        );
        return {
          status: 200,
          body: cdrList(
            Array.from({ length: page === 3 ? 7 : 50 }, (_, index) =>
              answeredCdr(page * 100 + index),
            ),
            { total: 107, page },
          ),
        };
      },
    });
    await screen.findByText('第 1–50 条，共 107 条');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 51–100 条，共 107 条');
    expect(lists.at(-1)!.get('page')).toBe('2');
    expect(location()).toBe('/portal/cdrs?page=2');
    await user.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('第 101–107 条，共 107 条');
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await user.click(screen.getByRole('button', { name: '上一页' }));
    await screen.findByText('第 1–50 条，共 107 条');
    expect(location()).toBe('/portal/cdrs');
  });

  it('offers the first page when the address points past the last page', async () => {
    const user = userEvent.setup();
    const { location } = cdrApp('/portal/cdrs?page=9', {
      list: (url) =>
        new URL(url, 'http://localhost').searchParams.get('page') === '9'
          ? { status: 200, body: cdrList([], { total: 3, page: 9 }) }
          : { status: 200, body: cdrList([answeredCdr()], { total: 3 }) },
    });
    expect(await screen.findByText('这一页没有话单')).toBeVisible();
    expect(screen.getByText('共 3 条，每页 50 条')).toBeVisible();
    expect(screen.queryByText('本月还没有话单')).toBeNull();
    await user.click(screen.getByRole('button', { name: '回到第 1 页' }));
    expect(await screen.findByRole('table')).toBeVisible();
    expect(location()).toBe('/portal/cdrs');
  });

  it('opens the detail with every field and the hangup cause in Chinese', async () => {
    const user = userEvent.setup();
    cdrApp('/portal/cdrs');
    await screen.findByRole('table');
    await user.click(
      screen.getAllByRole('button', { name: /查看话单详情/ })[0]!,
    );
    const dialog = await screen.findByRole('dialog');
    const text = dialog.textContent;
    for (const expected of [
      '话单详情',
      '075586001234',
      '+447700900123',
      '英国 · 手机',
      '447',
      '2026-10-16 17:59:50',
      '2026-10-16 18:00:00',
      '2026-10-16 18:03:50',
      '3分50秒',
      '4分钟',
      '0.0450',
      'NORMAL_CLEARING（正常挂断）',
      '00000000-0000-4000-8000-000000000001',
      '¥0.18',
    ])
      expect(text).toContain(expected);
    expect(text).not.toContain('GB');
    expect(text).not.toContain('验证');
  });

  it('shows the empty states with and without filters', async () => {
    const user = userEvent.setup();
    cdrApp('/portal/cdrs', {
      list: () => ({ status: 200, body: cdrList([]) }),
    });
    expect(await screen.findByText('本月还没有话单')).toBeVisible();
    await user.type(screen.getByRole('searchbox', { name: '被叫号码' }), '999');
    expect(await screen.findByText('没有符合条件的话单')).toBeVisible();
    expect(screen.getByText(/被叫号码「999」/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByText('本月还没有话单')).toBeVisible();
  });

  it('shows a retryable error when the list cannot be loaded', async () => {
    const user = userEvent.setup();
    let failing = true;
    cdrApp('/portal/cdrs', {
      list: () =>
        failing
          ? {
              status: 429,
              body: {
                error: {
                  code: 'RATE_LIMITED',
                  message: '请求过于频繁',
                  requestId: 'req-1',
                  retryAfterSeconds: 1,
                },
              },
            }
          : { status: 200, body: cdrList([answeredCdr()]) },
    });
    expect(await screen.findByText('话单加载失败')).toBeVisible();
    failing = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('has no unverified wording or filter anywhere in the page', async () => {
    cdrApp('/portal/cdrs');
    await screen.findByRole('table');
    expect(document.body).not.toHaveTextContent('未经验证');
    expect(screen.queryByText('仅看未经验证')).toBeNull();
    expect(screen.queryByText('删除话单')).toBeNull();
  });

  it('adds the CDR entry to the portal navigation', async () => {
    cdrApp('/portal/cdrs');
    await screen.findByRole('table');
    const nav = screen.getAllByRole('navigation', { name: '主导航' })[0]!;
    expect(within(nav).getByRole('link', { name: '话单' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('portal CDR list on a phone', () => {
  it('keeps the search on the page and moves range, country and status into the filter sheet', async () => {
    const user = userEvent.setup();
    const { lists } = cdrApp('/portal/cdrs', {
      list: () => ({
        status: 200,
        body: cdrList([answeredCdr()], { total: 13517 }),
      }),
    });
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: '筛选' }));
    const sheet = await screen.findByRole('dialog', { name: '筛选' });
    expect(within(sheet).getByText('日期范围')).toBeVisible();
    expect(within(sheet).getByText('最长一个月')).toBeVisible();
    await user.selectOptions(
      within(sheet).getByRole('combobox', { name: '国家' }),
      '英国',
    );
    await user.click(within(sheet).getByRole('button', { name: '全部' }));
    await waitFor(() =>
      expect(Object.fromEntries(lists.at(-1)!)).toMatchObject({
        country: '英国',
        status: 'all',
      }),
    );
    expect(
      screen.getByRole('button', { name: '筛选，已选 2 项', hidden: true }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole('button', { name: '查看 13,517 条结果' }),
    ).toBeVisible();
    await user.click(within(sheet).getByRole('button', { name: '清除筛选' }));
    await waitFor(() =>
      expect(Object.fromEntries(lists.at(-1)!)).toEqual({
        from: '2026-10-01',
        to: '2026-10-17',
        status: 'answered',
        page: '1',
      }),
    );
  });

  it('shows the card with the callee, the merged country label, duration and charge', async () => {
    cdrApp('/portal/cdrs');
    const card = (
      await screen.findAllByRole('button', { name: /查看话单详情/ })
    ).find((button) => button.tagName === 'BUTTON' && button.closest('ul'))!;
    expect(card).toHaveTextContent('+447700900123');
    expect(card).toHaveTextContent('¥0.18');
    expect(card).toHaveTextContent('英国 · 手机 · 3分50秒');
    expect(card).toHaveTextContent('10-16 18:00:00');
  });
});

describe('portal CDR export', () => {
  it('posts the current filters and saves the file under the server filename', async () => {
    const user = userEvent.setup();
    const { exports } = cdrApp(
      '/portal/cdrs?country=%E8%8B%B1%E5%9B%BD&status=all&callee=%22%2B44%207700%22',
    );
    await screen.findByRole('table');
    await user.click(
      screen.getByRole('button', { name: '导出 CSV（当前筛选）' }),
    );
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(exports).toEqual([
      {
        from: '2026-10-01',
        to: '2026-10-17',
        callee: '447700',
        country: '英国',
        status: 'all',
      },
    ]);
    expect(downloadBlob.mock.calls[0]![0]).toBe(
      'cdrs_ABC001_2026-10-01_2026-10-17.csv',
    );
    expect(await downloadBlob.mock.calls[0]![1].text()).toBe('csv');
  });

  it('disables the button while exporting so the export slot is not taken twice', async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { handler } = adminApi(
      {
        [`GET ${listPath}`]: () => ({
          status: 200,
          body: cdrList([answeredCdr()]),
        }),
        [`GET ${listPath}/countries`]: () => ({
          status: 200,
          body: { countries: [] },
        }),
        [`POST ${listPath}/export`]: async () => {
          await gate;
          return {
            status: 200,
            file: { text: 'csv', type: 'text/csv; charset=utf-8' },
          };
        },
      },
      customerSession,
    );
    const { fetchMock } = renderApp('/portal/cdrs', handler);
    await screen.findByRole('table');
    await user.click(
      screen.getByRole('button', { name: '导出 CSV（当前筛选）' }),
    );
    const busy = await screen.findByRole('button', { name: '正在导出…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    release();
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/export')),
    ).toHaveLength(1);
    // 服务端文件名缺省时用固定名称，不信任其他内容。
    expect(downloadBlob.mock.calls[0]![0]).toBe('export.csv');
  });

  it('shows the rate limit with a retry that exports again, and clears it on success', async () => {
    const user = userEvent.setup();
    let busy = true;
    const { exports } = cdrApp('/portal/cdrs', {
      exportReply: () =>
        busy
          ? {
              status: 429,
              body: {
                error: {
                  code: 'RATE_LIMITED',
                  message: '导出人数过多',
                  requestId: 'req-2',
                  retryAfterSeconds: 5,
                },
              },
            }
          : {
              status: 200,
              file: { text: 'csv', type: 'text/csv; charset=utf-8' },
            },
    });
    await screen.findByRole('table');
    await user.click(
      screen.getByRole('button', { name: '导出 CSV（当前筛选）' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('导出失败');
    busy = false;
    await user.click(within(alert).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    expect(exports).toHaveLength(2);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('reports an interrupted download and saves nothing', async () => {
    const user = userEvent.setup();
    const { handler } = adminApi(
      {
        [`GET ${listPath}`]: () => ({
          status: 200,
          body: cdrList([answeredCdr()]),
        }),
        [`GET ${listPath}/countries`]: () => ({
          status: 200,
          body: { countries: [] },
        }),
        [`POST ${listPath}/export`]: () => {
          throw new Error('connection reset');
        },
      },
      customerSession,
    );
    renderApp('/portal/cdrs', handler);
    await screen.findByRole('table');
    await user.click(
      screen.getByRole('button', { name: '导出 CSV（当前筛选）' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '导出中断，请重试',
    );
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
