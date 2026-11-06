import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, customerSession, renderAppWithLocale } from '../../test/app';
import { answeredCdr, cdrList } from '../../test/cdr';
import { homeResponse } from '../../test/portal-home';
import {
  septemberDetail,
  statementsResponse,
} from '../../test/portal-statements';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const englishSession = {
  ...customerSession,
  identity: {
    ...customerSession.identity,
    locale: 'en',
    tenant: {
      ...customerSession.identity.tenant,
      name: 'Shenzhen Example Technology Ltd',
    },
  },
};

const englishHome = {
  ...homeResponse,
  recentCalls: homeResponse.recentCalls.map((call, index) => ({
    ...call,
    country: index === 0 ? 'United Kingdom' : 'Japan',
    description: index === 0 ? 'Mobile' : null,
  })),
};

const countryNames = [
  'China',
  'Jamaica',
  'United Kingdom',
  'Japan',
  'Hong Kong',
  'Singapore',
  'Ireland',
  'United States/Canada',
];

const englishDetail = {
  ...septemberDetail,
  tenant: { code: 'ABC001', name: 'Shenzhen Example Technology Ltd' },
  countries: septemberDetail.countries.map((country, index) => ({
    ...country,
    country: countryNames[index] ?? 'China',
  })),
};

const ledgerResponse = {
  currency: 'CNY',
  balance: '500.00',
  totalAmount: '500.00',
  items: [
    {
      id: '00000000-0000-4000-8000-000000000031',
      kind: 'recharge',
      amount: '500.00',
      balanceAfter: '500.00',
      occurredAt: '2026-09-23T02:15:36.000Z',
      note: '账户充值',
      noteKey: 'ledger.accountRecharge',
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1 },
};

function renderPage(path: string, routes: Parameters<typeof adminApi>[0]) {
  const { handler } = adminApi(routes, englishSession);
  return renderAppWithLocale('en', path, handler);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('portal pages (English)', () => {
  it('renders the portal home in English without Chinese', async () => {
    const { container } = await renderPage('/', {
      'GET /api/portal/home': () => ({ status: 200, body: englishHome }),
    });

    expect(
      await screen.findByRole('region', { name: 'Current balance' }),
    ).toHaveTextContent('-¥35.20');
    expect(
      screen.getByRole('region', { name: 'Overdraft limit' }),
    ).toHaveTextContent('¥100.00');
    expect(
      screen.getByRole('region', { name: 'Spend this month' }),
    ).toHaveTextContent('Sep 2026 · as of today');
    const minutes = screen.getByRole('region', {
      name: 'Call minutes this month',
    });
    expect(minutes).toHaveTextContent(/49,726 min/);
    expect(minutes).toHaveTextContent(/12,804 answered calls/);
    expect(screen.getByText('Daily spend for the last 30 days')).toBeVisible();
    expect(screen.getAllByText('Last 10 calls').length).toBeGreaterThan(0);
    expect(screen.getByText('Beijing time (UTC+8)')).toBeVisible();
    expect(screen.getByRole('link', { name: /View all/ })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the call list in English with the Beijing time note', async () => {
    const { container } = await renderPage('/portal/cdrs', {
      'GET /api/portal/cdrs': () => ({
        status: 200,
        body: cdrList([
          answeredCdr(1, {
            country: 'United Kingdom',
            description: 'Mobile',
          }),
        ]),
      }),
      'GET /api/portal/cdrs/countries': () => ({
        status: 200,
        body: { countries: ['United Kingdom'] },
      }),
    });

    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toContain('Billed minutes');
    expect(screen.getByText('Beijing time (UTC+8)')).toBeVisible();
    expect(
      screen.getByRole('button', { name: /Export CSV \(current filters\)/ }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the monthly statement list in English without Chinese', async () => {
    const { container } = await renderPage('/portal/statements', {
      'GET /api/portal/statements': () => ({
        status: 200,
        body: statementsResponse,
      }),
    });

    const table = await screen.findByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((cell) => cell.textContent),
    ).toEqual([
      'Month',
      'Opening balance',
      'Recharge',
      'Gift',
      'Adjustment',
      'Call charges',
      'Closing balance',
      'Call minutes',
      'View details',
    ]);
    expect(screen.getAllByText('Sep 2026').length).toBeGreaterThan(0);
    expect(
      screen.getByText(/By calendar month, Beijing time \(UTC\+8\)/),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders a monthly statement in English without Chinese', async () => {
    const { container } = await renderPage('/portal/statements/2026-09', {
      'GET /api/portal/statements/2026-09': () => ({
        status: 200,
        body: englishDetail,
      }),
    });

    expect(
      await screen.findByRole(
        'heading',
        { name: 'Sep 2026' },
        { timeout: 3000 },
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Statement summary' }),
    ).toHaveTextContent('Opening balance');
    expect(screen.getByText(/Beijing time \(UTC\+8\)/)).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders balance history in English without Chinese', async () => {
    const { container } = await renderPage('/portal/ledger', {
      'GET /api/portal/ledger': () => ({ status: 200, body: ledgerResponse }),
    });

    expect(
      await screen.findByRole('heading', { name: 'Balance history' }),
    ).toBeVisible();
    expect(
      (await screen.findAllByText('Account recharge')).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('1 entry')).toBeVisible();
    expect(screen.getAllByText('23 Sep 10:15').length).toBeGreaterThan(0);
    expect(
      screen.getByRole('button', {
        name: /Date range \(Beijing time \(UTC\+8\)\)/,
      }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders account settings in English without Chinese', async () => {
    const { container } = await renderPage('/portal/settings', {});

    expect(
      await screen.findByRole('heading', { name: 'Account settings' }),
    ).toBeVisible();
    expect(screen.getByText('CNY (Chinese yuan)')).toBeVisible();
    expect(
      screen.getByText('Sign-ins on other devices will be signed out'),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
