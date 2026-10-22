import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiry } from '../../lib/session';
import { customerSession, renderApp } from '../../test/app';
import { homeResponse } from '../../test/portal-home';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
});

function renderHome(home: object = homeResponse) {
  const paths: string[] = [];
  renderApp('/', (path) => {
    paths.push(path);
    if (path === '/api/auth/session')
      return { status: 200, body: customerSession };
    if (path === '/api/portal/home') return { status: 200, body: home };
    throw new Error(`unexpected ${path}`);
  });
  return paths;
}

const suspended = {
  ...homeResponse,
  balance: '-100.36',
  availableBalance: '-0.36',
  health: 'suspended',
};

describe('portal home', () => {
  it('shows the overdraft state with the four figures and the available credit', async () => {
    const paths = renderHome();
    expect(
      await screen.findByRole('region', { name: '当前余额' }),
    ).toHaveTextContent('-¥35.20可用额度 ¥64.80');
    expect(screen.getByRole('region', { name: '透支额度' })).toHaveTextContent(
      '¥100.00',
    );
    expect(screen.getByRole('region', { name: '本月消费' })).toHaveTextContent(
      '¥2,486.30',
    );
    expect(screen.getByRole('region', { name: '本月消费' })).toHaveTextContent(
      '2026年9月 · 截至今日',
    );
    expect(
      screen.getByRole('region', { name: '本月通话分钟数' }),
    ).toHaveTextContent('49,726分钟已接通 12,804 通');
    expect(screen.getAllByText('透支中').length).toBeGreaterThan(0);
    expect(screen.getByText(/余额已为负数，可用额度仍有/)).toHaveTextContent(
      '¥64.80',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    // 首页只调用 portalHome，不再读 portalContext。
    expect(paths).not.toContain('/api/portal/context');
  });

  it('shows the suspended banner from design 1c and the 已停机 tag', async () => {
    renderHome(suspended);
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(
      '余额不足，已暂停呼叫请联系客服充值，到账后自动恢复呼叫。',
    );
    expect(screen.getAllByText('已停机').length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: '当前余额' })).toHaveTextContent(
      '-¥100.36',
    );
  });

  it('labels a disabled tenant 已停用 and shows no suspension banner', async () => {
    renderHome({ ...homeResponse, health: 'disabled' });
    await screen.findByRole('region', { name: '当前余额' });
    expect(screen.getAllByText('已停用').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('余额不足，已暂停呼叫')).toBeNull();
  });

  it('draws 30 bars whose tooltips carry the date and amount only', async () => {
    renderHome();
    const chart = await screen.findByRole('region', {
      name: '最近 30 天每日消费',
    });
    const bars = within(chart).getAllByRole('listitem');
    expect(bars).toHaveLength(30);
    expect(within(chart).getByLabelText('合计 ¥168.64')).toBeVisible();
    const today = bars.at(-1)!;
    expect(today).toHaveAttribute('title', '2026-09-29（今日） ¥88.64');
    expect(bars.at(-2)).toHaveAttribute('title', '2026-09-28 ¥80.00');
    for (const bar of bars) expect(bar.getAttribute('title')).not.toMatch(/通/);
  });

  it('lists the recent answered calls with country and description', async () => {
    renderHome();
    const section = await screen.findByRole('region', { name: '最近话单' });
    const table = within(section).getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual(['接通时间', '被叫号码', '国家', '通话时长', '计费时长', '费用']);
    const [first, second] = within(table).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent(
      '2026-09-29 14:03:22447700900123英国 · 手机3分50秒4分钟¥0.18',
    );
    // 说明为空只显示国家。
    expect(second).toHaveTextContent(
      '2026-09-29 13:58:0781312345678日本12分04秒13分钟¥0.46',
    );
  });

  it('shows the empty state instead of the chart and list when there are no calls', async () => {
    renderHome({
      ...homeResponse,
      health: 'normal',
      balance: '200',
      availableBalance: '300',
      usage: {
        ...homeResponse.usage,
        monthSpend: '0',
        monthCallMinutes: '0',
        answeredCalls: 0,
        dailyTotal: '0',
        daily: homeResponse.usage.daily.map(({ date }) => ({
          date,
          spend: '0',
        })),
      },
      recentCalls: [],
    });
    const empty = await screen.findByRole('region', { name: '没有通话记录' });
    expect(empty).toHaveTextContent(
      '没有通话记录开始外呼后，消费图表和最近话单会显示在这里',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(
      screen.queryByRole('region', { name: '最近 30 天每日消费' }),
    ).toBeNull();
    expect(screen.getByRole('region', { name: '当前余额' })).toHaveTextContent(
      '¥200.00',
    );
  });

  it('offers neither the monthly statement nor unanswered-call figures', async () => {
    renderHome();
    await screen.findByRole('region', { name: '当前余额' });
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('link', { name: '首页' })).toBeVisible();
    expect(within(nav).queryByRole('link', { name: '月账单' })).toBeNull();
    expect(screen.queryByText(/未接通/)).toBeNull();
  });
});
