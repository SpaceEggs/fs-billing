import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminApi, page, renderApp } from '../../../test/app';

const tenantId = '00000000-0000-4000-8000-00000000a001';
const detailPath = `/api/admin/tenants/${tenantId}`;

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

function ledgerApp(path: string, items: unknown[] = []) {
  const gets: URLSearchParams[] = [];
  const { handler } = adminApi({
    [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
    [`GET ${detailPath}/ledger`]: (url) => {
      gets.push(new URL(url, 'http://localhost').searchParams);
      return {
        status: 200,
        body: {
          currency: 'CNY',
          balance: '500',
          totalAmount: '0',
          ...page(items, items.length),
        },
      };
    },
    [`GET ${detailPath}/rates`]: () => ({
      status: 200,
      body: {
        currency: 'CNY',
        current: {
          id: '00000000-0000-4000-8000-0000000000aa',
          effectiveFrom: '2026-10-01T00:00:00.000Z',
          entries: [],
        },
        scheduled: [],
      },
    }),
  });
  return { gets, ...renderApp(path, handler) };
}

beforeEach(() => {
  // 北京时间 2026-10-17 18:00。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T10:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const rangeButton = (from: string, to: string) =>
  screen.getByRole('button', {
    name: `日期范围（北京时间）：${from} 至 ${to}`,
  });

describe('ledger tab filters', () => {
  it('renders merged charges without invented entry fields and keeps manual precision', async () => {
    ledgerApp(`/admin/tenants/${tenantId}?tab=ledger`, [
      {
        kind: 'call_charge',
        day: '2026-10-16',
        calls: 1234,
        amount: '-12.3456',
        balanceAfter: '487.6544',
        occurredAt: '2026-10-16T10:00:00.000Z',
        partial: false,
      },
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        kind: 'adjustment',
        amount: '-1.2345',
        balanceAfter: '486.4199',
        occurredAt: '2026-10-16T09:00:00.000Z',
        note: '人工调账',
        noteVisibility: 'customer',
        paymentStatus: null,
        actor: { id: '00000000-0000-4000-8000-0000000000b2', name: '王敏' },
      },
    ]);
    await screen.findByText('2026-10-16 通话扣费，共 1,234 通');
    expect(
      screen.getAllByText('当前余额').at(-1)?.parentElement,
    ).toHaveTextContent('¥500.00');
    expect(screen.getByText('筛选金额合计').parentElement).toHaveTextContent(
      '¥0.00',
    );
    const chargeRow = screen
      .getByText('2026-10-16 通话扣费，共 1,234 通')
      .closest('tr');
    expect(chargeRow).toHaveTextContent('—');
    expect(chargeRow).not.toHaveTextContent('系统');
    expect(screen.getAllByText('王敏')).toHaveLength(2);
    expect(screen.getByText('人工调账')).toBeVisible();
    expect(screen.getAllByText('-¥1.2345')).toHaveLength(2);
    expect(screen.getAllByText('-¥12.35')).toHaveLength(2);
  });

  it('defaults to the current Beijing month up to today without writing the address', async () => {
    const { gets, location } = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger`,
    );
    await screen.findByText('该日期范围内没有余额流水');
    expect(rangeButton('2026-10-01', '2026-10-17')).toHaveTextContent(
      '2026-10-01 — 2026-10-17',
    );
    expect(Object.fromEntries(gets.at(-1)!)).toEqual({
      page: '1',
      pageSize: '25',
      from: '2026-10-01',
      to: '2026-10-17',
    });
    expect(location()).toBe(`/admin/tenants/${tenantId}?tab=ledger`);
  });

  it('picks a range on the calendar, in either order, and goes back to page one', async () => {
    const { gets, location } = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&page=3`,
    );
    await screen.findByText('该日期范围内没有余额流水');
    expect(gets.at(-1)?.get('page')).toBe('3');

    const user = userEvent.setup();
    await user.click(rangeButton('2026-10-01', '2026-10-17'));
    const dialog = screen.getByRole('dialog', { name: '日期范围（北京时间）' });
    expect(
      within(dialog).getByRole('button', { name: '2026-10-18' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: '下个月' }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '上个月' }));
    expect(dialog).toHaveTextContent('2026年9月');
    await user.click(
      within(dialog).getByRole('button', { name: '2026-09-29' }),
    );
    expect(within(dialog).getByRole('button', { name: '确定' })).toBeDisabled();
    expect(dialog).toHaveTextContent('2026-09-29 — 请选择结束日期');
    await user.click(
      within(dialog).getByRole('button', { name: '2026-09-01' }),
    );
    expect(dialog).toHaveTextContent('2026-09-01 — 2026-09-29');
    await user.click(within(dialog).getByRole('button', { name: '确定' }));

    await waitFor(() => expect(gets.at(-1)?.get('to')).toBe('2026-09-29'));
    expect(gets.at(-1)?.get('from')).toBe('2026-09-01');
    expect(gets.at(-1)?.get('page')).toBe('1');
    expect(new URLSearchParams(location().split('?')[1])).toEqual(
      new URLSearchParams({
        tab: 'ledger',
        from: '2026-09-01',
        to: '2026-09-29',
      }),
    );
    expect(rangeButton('2026-09-01', '2026-09-29')).toBeVisible();
  });

  it('cancelling the calendar keeps the range', async () => {
    const { gets } = ledgerApp(`/admin/tenants/${tenantId}?tab=ledger`);
    await screen.findByText('该日期范围内没有余额流水');
    const user = userEvent.setup();
    await user.click(rangeButton('2026-10-01', '2026-10-17'));
    await user.click(screen.getByRole('button', { name: '2026-10-05' }));
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(rangeButton('2026-10-01', '2026-10-17')).toBeVisible();
    expect(gets.at(-1)?.get('from')).toBe('2026-10-01');
  });

  it('restores the filters from the address and keeps them across tab switches', async () => {
    const { gets } = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-09-01&to=2026-09-29&kind=gift&page=2`,
    );
    await screen.findByText('该日期范围内没有赠送流水');
    expect(rangeButton('2026-09-01', '2026-09-29')).toBeVisible();
    expect(screen.getByLabelText('类型')).toHaveValue('gift');
    expect(Object.fromEntries(gets.at(-1)!)).toEqual({
      page: '2',
      pageSize: '25',
      kind: 'gift',
      from: '2026-09-01',
      to: '2026-09-29',
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole('link', { name: '费率' }));
    await screen.findByRole('region', { name: '费率表' });
    await user.click(screen.getByRole('link', { name: '余额流水' }));
    await screen.findByText('该日期范围内没有赠送流水');
    expect(rangeButton('2026-09-01', '2026-09-29')).toBeVisible();
    expect(screen.getByLabelText('类型')).toHaveValue('gift');
  });

  it('falls back to the month for malformed filters', async () => {
    const malformed = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-02-30&to=yesterday&kind=bogus&page=0`,
    );
    await screen.findByText('该日期范围内没有余额流水');
    expect(rangeButton('2026-10-01', '2026-10-17')).toBeVisible();
    expect(Object.fromEntries(malformed.gets.at(-1)!)).toEqual({
      page: '1',
      pageSize: '25',
      from: '2026-10-01',
      to: '2026-10-17',
    });
  });

  it('orders a reversed range from the address', async () => {
    const reversed = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-09-29&to=2026-09-01`,
    );
    await screen.findByText('该日期范围内没有余额流水');
    expect(rangeButton('2026-09-01', '2026-09-29')).toBeVisible();
    expect(reversed.gets.at(-1)?.get('from')).toBe('2026-09-01');
  });
});
