import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
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
    const { from: nextDay } = beijingDayRange({ from: '2026-09-30', to: '' });
    expect(range.to! > '2026-09-29T23:59:59.999500+08:00').toBe(true);
    expect(range.to! < nextDay!).toBe(true);
    expect(adminLedgerQuerySchema.parse(range)).toMatchObject(range);
  });
});

describe('ledger tab filters', () => {
  it('queries whole Beijing days and keeps the range in the address, back on page one', async () => {
    const { gets, location } = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&page=3`,
    );
    await screen.findByText('暂无余额流水');
    expect(gets.at(-1)?.get('page')).toBe('3');

    fireEvent.change(screen.getByLabelText('开始日期'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('结束日期'), {
      target: { value: '2026-09-29' },
    });
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
    expect(await screen.findByText('请调整日期范围或类型')).toBeVisible();
  });

  it('restores the filters from the address and keeps them across tab switches', async () => {
    const { gets } = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-09-01&to=2026-09-29&kind=gift&page=2`,
    );
    await screen.findByText('没有符合条件的赠送流水');
    expect(screen.getByLabelText('开始日期')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('结束日期')).toHaveValue('2026-09-29');
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
    expect(await screen.findByLabelText('开始日期')).toHaveValue('2026-09-01');
    expect(screen.getByLabelText('结束日期')).toHaveValue('2026-09-29');
    expect(screen.getByLabelText('类型')).toHaveValue('gift');
  });

  it('drops malformed filters from the address', async () => {
    const { gets } = ledgerApp(
      `/admin/tenants/${tenantId}?tab=ledger&from=2026-02-30&to=yesterday&kind=bogus&page=0`,
    );
    await screen.findByText('暂无余额流水');
    expect(screen.getByLabelText('开始日期')).toHaveValue('');
    expect(Object.fromEntries(gets.at(-1)!)).toEqual({
      page: '1',
      pageSize: '25',
    });
  });

  it('flags a start after the end and keeps the range out of the query', async () => {
    const { gets } = ledgerApp(`/admin/tenants/${tenantId}?tab=ledger`);
    await screen.findByText('暂无余额流水');

    fireEvent.change(screen.getByLabelText('结束日期'), {
      target: { value: '2026-09-01' },
    });
    fireEvent.change(screen.getByLabelText('开始日期'), {
      target: { value: '2026-09-02' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '开始日期不能晚于结束日期',
    );
    expect(
      screen.getByRole('group', { name: '日期范围（北京时间）' }),
    ).toHaveAccessibleDescription('开始日期不能晚于结束日期');
    expect(gets.at(-1)?.has('from')).toBe(false);
    expect(gets.at(-1)?.has('to')).toBe(false);
  });
});
