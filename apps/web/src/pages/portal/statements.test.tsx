import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sessionExpiry } from '../../lib/session';
import { apiError, customerSession, renderApp } from '../../test/app';
import {
  emptyStatementsResponse,
  septemberDetail,
  statementsResponse,
} from '../../test/portal-statements';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionExpiry.clear();
});

function renderStatements(
  list: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: statementsResponse,
  }),
  path = '/portal/statements',
) {
  const paths: string[] = [];
  const app = renderApp(path, (requested) => {
    paths.push(requested);
    if (requested === '/api/auth/session')
      return { status: 200, body: customerSession };
    if (requested === '/api/portal/statements') return list();
    if (requested === '/api/portal/statements/2026-09')
      return { status: 200, body: septemberDetail };
    throw new Error(`unexpected ${requested}`);
  });
  return { ...app, paths };
}

describe('portal statements list', () => {
  it('is in the navigation between CDRs and the ledger, and highlights itself', async () => {
    renderStatements();
    await screen.findByRole('table');
    const nav = screen.getAllByRole('navigation', { name: '主导航' })[0];
    if (!nav) throw new Error('navigation');
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['首页', '话单', '月账单', '余额流水', '账号设置']);
    expect(within(nav).getByRole('link', { name: '月账单' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('puts a decorative icon before every portal nav label', async () => {
    renderStatements();
    await screen.findByRole('table');
    const nav = screen.getAllByRole('navigation', { name: '主导航' })[0]!;
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const link of links) {
      const icon = link.firstElementChild;
      expect(icon?.tagName.toLowerCase()).toBe('svg');
      expect(icon).toHaveAttribute('aria-hidden', 'true');
    }
  });

  it('lists the live month first, then the finished one, with the mockup figures', async () => {
    renderStatements();
    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([
      '月份',
      '期初余额',
      '充值',
      '赠送',
      '调账',
      '通话扣费',
      '期末余额',
      '通话分钟数',
      '查看详情',
    ]);
    const [september, august] = within(table).getAllByRole('row').slice(1);
    expect(september).toHaveTextContent(
      '2026年9月本月（进行中）¥1,176.60¥1,300.00¥0.00-¥25.50¥2,486.30-¥35.2049,726›',
    );
    expect(august).toHaveTextContent(
      '2026年8月¥0.00¥3,000.00¥50.00¥0.00¥1,873.40¥1,176.6037,468›',
    );
    // 调账为负与期末为负用红色，期末为正不用。
    expect(within(september!).getByText('-¥25.50')).toHaveClass('text-neg');
    expect(within(september!).getByText('-¥35.20')).toHaveClass('text-neg');
    expect(within(august!).getByText('¥1,176.60')).not.toHaveClass('text-neg');
  });

  it('notes the live update time and that recharge covers every credit', async () => {
    renderStatements();
    await screen.findByRole('table');
    expect(screen.getByText(/本月数据实时更新/)).toHaveTextContent(
      '本月数据实时更新，截至 2026-09-29 14:03:22；每月 1 日凌晨生成上月正式账单。「充值」包含所有入账充值。',
    );
  });

  it('opens a month from its row', async () => {
    const user = userEvent.setup();
    const { location } = renderStatements();
    const table = await screen.findByRole('table');
    await user.click(within(table).getAllByRole('row')[1]!);
    expect(
      await screen.findByRole('heading', { name: '2026年9月' }),
    ).toBeVisible();
    expect(location()).toBe('/portal/statements/2026-09');
  });

  it('keeps phone cards with the opening, the call charges and the closing balance', async () => {
    renderStatements();
    await screen.findByRole('table');
    const cards = screen.getAllByRole('listitem');
    expect(cards).toHaveLength(2);
    expect(cards[0]).toHaveTextContent(
      '2026年9月本月（进行中）›期初¥1,176.60通话扣费¥2,486.30期末-¥35.20',
    );
    expect(within(cards[0]!).getByRole('link')).toHaveAttribute(
      'href',
      '/portal/statements/2026-09',
    );
  });

  it('marks a finished month without a statement row as waiting to be generated', async () => {
    const [, august] = statementsResponse.items;
    if (!august) throw new Error('fixture');
    renderStatements(() => ({
      status: 200,
      body: {
        ...statementsResponse,
        items: [
          {
            ...august,
            month: '2026-09',
            state: 'pending',
            generatedAt: null,
          },
          august,
        ],
      },
    }));
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent(
      '2026年9月待生成',
    );
  });

  it('shows 还没有账单 only without statements and without activity this month', async () => {
    renderStatements(() => ({ status: 200, body: emptyStatementsResponse }));
    const empty = await screen.findByRole('region', { name: '还没有账单' });
    expect(empty).toHaveTextContent('还没有账单');
    expect(empty).toHaveTextContent(
      '账户开通后，本月账单会实时显示在这里；每月 1 日凌晨生成上月正式账单。',
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText('USD')).toBeInTheDocument();
  });

  it('shows the live row instead of the empty state once there is activity this month', async () => {
    const [live] = emptyStatementsResponse.items;
    renderStatements(() => ({
      status: 200,
      body: {
        ...emptyStatementsResponse,
        items: [{ ...live, figures: { ...live!.figures, calls: 20 } }],
      },
    }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '还没有账单' })).toBeNull();
  });

  it('offers a retry when loading fails', async () => {
    const user = userEvent.setup();
    let failing = true;
    renderStatements(() =>
      failing
        ? {
            status: 429,
            body: apiError('RATE_LIMITED', { retryAfterSeconds: 1 }),
          }
        : { status: 200, body: statementsResponse },
    );
    expect(await screen.findByText('月账单加载失败')).toBeVisible();
    failing = false;
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });
});
