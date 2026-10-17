import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminLedgerQuerySchema } from '@fs-billing/shared';
import { adminApi, page, renderApp } from '../../../test/app';
import { beijingDayRange } from './ledger-tab';

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

function ledgerApp(path: string) {
  const gets: URLSearchParams[] = [];
  const { handler } = adminApi({
    [`GET ${detailPath}`]: () => ({ status: 200, body: detail }),
    [`GET ${detailPath}/ledger`]: (url) => {
      gets.push(new URL(url, 'http://localhost').searchParams);
      return { status: 200, body: { currency: 'CNY', ...page([], 0) } };
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

describe('beijingDayRange', () => {
  it('covers the last microsecond of the end day and nothing of the next', () => {
    const range = beijingDayRange({ from: '2026-09-01', to: '2026-09-29' });
    expect(range).toEqual({
      from: '2026-09-01T00:00:00.000000+08:00',
      to: '2026-09-29T23:59:59.999999+08:00',
    });
    // 同一时区、同一长度的时间串按字典序比较即按时间比较。
    const { from: nextDay } = beijingDayRange({
      from: '2026-09-30',
      to: '2026-09-30',
    });
    expect(range.to > '2026-09-29T23:59:59.999500+08:00').toBe(true);
    expect(range.to < nextDay).toBe(true);
    expect(adminLedgerQuerySchema.parse(range)).toMatchObject(range);
  });
});

const rangeButton = (from: string, to: string) =>
  screen.getByRole('button', {
    name: `日期范围（北京时间）：${from} 至 ${to}`,
  });

describe('ledger tab filters', () => {
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
      from: '2026-10-01T00:00:00.000000+08:00',
      to: '2026-10-17T23:59:59.999999+08:00',
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

    await waitFor(() =>
      expect(gets.at(-1)?.get('to')).toBe('2026-09-29T23:59:59.999999+08:00'),
    );
    expect(gets.at(-1)?.get('from')).toBe('2026-09-01T00:00:00.000000+08:00');
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
    expect(gets.at(-1)?.get('from')).toBe('2026-10-01T00:00:00.000000+08:00');
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
      from: '2026-09-01T00:00:00.000000+08:00',
      to: '2026-09-29T23:59:59.999999+08:00',
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
      from: '2026-10-01T00:00:00.000000+08:00',
      to: '2026-10-17T23:59:59.999999+08:00',
    });
  });

  it('orders a reversed range from the address', async () => {
    const reversed = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-09-29&to=2026-09-01`,
    );
    await screen.findByText('该日期范围内没有余额流水');
    expect(rangeButton('2026-09-01', '2026-09-29')).toBeVisible();
    expect(reversed.gets.at(-1)?.get('from')).toBe(
      '2026-09-01T00:00:00.000000+08:00',
    );
  });
});
