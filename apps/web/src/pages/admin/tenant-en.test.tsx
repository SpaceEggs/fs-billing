import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApi,
  adminSession,
  page,
  renderAppWithLocale,
} from '../../test/app';
import { answeredCdr, cdrList } from '../../test/cdr';
import {
  augustFigures,
  finalRow,
  inProgressRow,
  septemberFigures,
} from '../../test/statements';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const tenantId = '00000000-0000-4000-8000-00000000a001';

const englishSession = {
  ...adminSession,
  identity: {
    ...adminSession.identity,
    name: 'Wang Min',
    email: 'wangmin@example.com',
    locale: 'en',
  },
};

const tenantSummary = {
  id: tenantId,
  code: 'ABC001',
  name: 'Shenzhen Example Technology Ltd',
  currency: 'CNY',
  status: 'active',
  health: 'normal',
  settingsConfigured: true,
  balance: '500',
  overdraftLimit: '100',
  availableBalance: '600',
  monthConsumption: '0',
  pendingReceivable: '0',
};

const tenant = {
  ...tenantSummary,
  contactName: 'Li Hua',
  contactPhone: '0755-12345678',
  remark: '',
  settings: {
    overdraftLimit: '100',
    lowBalanceThreshold: '200',
    emails: ['billing@example.com'],
  },
  createdAt: '2026-08-12T02:31:02.000Z',
};

const overview = {
  asOf: '2026-10-15T06:03:27.120Z',
  currency: 'CNY',
  monthSpend: '2486.3',
  monthCallMinutes: '49726',
  answeredCalls: 12804,
  unansweredCalls: 713,
  daily: Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 8, 16 + index)).toISOString().slice(0, 10),
    spend: '0',
  })),
  dailyTotal: '0',
};

const rates = {
  currency: 'CNY',
  current: {
    id: '00000000-0000-4000-8000-00000000c001',
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    entries: [
      {
        iso: 'GB',
        country: 'United Kingdom',
        description: 'Mobile',
        prefix: '44',
        rate: '0.0450',
      },
    ],
  },
  scheduled: [],
};

const ledger = {
  currency: 'CNY',
  balance: '500',
  totalAmount: '-12.34',
  items: [
    {
      kind: 'call_charge',
      day: '2026-11-01',
      calls: 20,
      amount: '-12.34',
      balanceAfter: '487.66',
      occurredAt: '2026-11-01T10:00:00.000Z',
      partial: false,
    },
  ],
  pagination: { page: 1, pageSize: 25, total: 1 },
};

const statements = {
  currency: 'CNY',
  tenant: { id: tenantId, code: tenant.code, name: tenant.name },
  asOf: '2026-10-17T10:00:00.000Z',
  items: [
    inProgressRow('2026-10', augustFigures),
    finalRow('2026-09', septemberFigures),
    finalRow('2026-08', augustFigures, {
      detailsDeleted: true,
      regenerable: { allowed: false, reason: 'details_deleted' },
    }),
  ],
};

const statementDetail = {
  currency: 'CNY',
  tenant: { id: tenantId, code: tenant.code, name: tenant.name },
  month: '2026-08',
  state: 'final',
  period: { from: '2026-08-12', to: '2026-08-31', openedOn: '2026-08-12' },
  asOf: null,
  generatedAt: '2026-09-01T18:00:15.000Z',
  firstGeneratedAt: '2026-09-01T18:00:15.000Z',
  detailsDeleted: false,
  version: 1,
  generatedBy: { id: '00000000-0000-4000-8000-00000000a002', name: 'Wang Min' },
  reconcile: { status: 'ok', reconciledAt: null, diff: null },
  breakdownGap: '0',
  regenerable: { allowed: true, reason: null },
  figures: augustFigures,
  countries: [
    { country: 'United Kingdom', calls: 1, minutes: '4', charge: '0.18' },
  ],
  days: [{ day: '2026-08-12', calls: 1, minutes: '4', charge: '0.18' }],
};

const portalAccount = {
  id: '00000000-0000-4000-8000-00000000b001',
  email: 'billing@abc-tech.com',
  status: 'active',
  lastLoginAt: null,
  createdAt: '2026-08-12T02:31:02.000Z',
};

function routes(extra: Parameters<typeof adminApi>[0] = {}) {
  return {
    'GET /api/admin/tenants': () => ({
      status: 200,
      body: page([tenantSummary]),
    }),
    [`GET /api/admin/tenants/${tenantId}`]: () => ({
      status: 200,
      body: tenant,
    }),
    [`GET /api/admin/tenants/${tenantId}/overview`]: () => ({
      status: 200,
      body: overview,
    }),
    [`GET /api/admin/tenants/${tenantId}/rates`]: () => ({
      status: 200,
      body: rates,
    }),
    [`GET /api/admin/tenants/${tenantId}/ledger`]: () => ({
      status: 200,
      body: ledger,
    }),
    [`GET /api/admin/tenants/${tenantId}/cdrs`]: () => ({
      status: 200,
      body: cdrList(
        [
          answeredCdr(1, {
            country: 'United Kingdom',
            description: 'Mobile',
          }),
        ],
        { unverifiedCalls: 0 },
      ),
    }),
    [`GET /api/admin/tenants/${tenantId}/cdrs/countries`]: () => ({
      status: 200,
      body: { countries: ['United Kingdom'] },
    }),
    [`GET /api/admin/tenants/${tenantId}/statements`]: () => ({
      status: 200,
      body: statements,
    }),
    [`GET /api/admin/tenants/${tenantId}/statements/2026-08`]: () => ({
      status: 200,
      body: statementDetail,
    }),
    [`GET /api/admin/tenants/${tenantId}/portal-accounts`]: () => ({
      status: 200,
      body: { items: [portalAccount] },
    }),
    'GET /api/admin/admins': () => ({ status: 200, body: page([], 0) }),
    ...extra,
  };
}

function renderPage(path: string, extra: Parameters<typeof adminApi>[0] = {}) {
  const { handler } = adminApi(routes(extra), englishSession);
  return renderAppWithLocale('en', path, handler);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('admin tenant pages (English)', () => {
  it('renders the tenant list in English without Chinese', async () => {
    const { container } = await renderPage('/admin/tenants');

    const table = await screen.findByRole('table');
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((cell) => cell.textContent);
    expect(headers).toContain('Tenant code');
    expect(headers).toContain('Current balance');
    expect(
      within(table).getByText('Shenzhen Example Technology Ltd'),
    ).toBeVisible();
    expect(
      within(table).getByRole('link', { name: 'Recharge ABC001' }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the new tenant form in English without Chinese', async () => {
    const { container } = await renderPage('/admin/tenants/new');

    expect(await screen.findByLabelText(/Tenant code/)).toBeVisible();
    expect(screen.getByLabelText(/Tenant name/)).toBeVisible();
    expect(screen.getByText('Limits and alerts')).toBeVisible();
    expect(screen.getByText('Portal account')).toBeVisible();
    expect(screen.getByText('Rate table')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create tenant' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the edit form in English without Chinese', async () => {
    const { container } = await renderPage(`/admin/tenants/${tenantId}/edit`);

    expect(await screen.findByLabelText(/Tenant name/)).toHaveValue(
      tenant.name,
    );
    expect(
      screen.getAllByText('Cannot be changed after creation').length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the overview tab in English without Chinese', async () => {
    const { container } = await renderPage(`/admin/tenants/${tenantId}`);

    expect(
      await screen.findByRole('region', { name: 'Spend this month' }),
    ).toHaveTextContent('¥2,486.30');
    expect(
      screen.getByRole('region', { name: 'Calls this month' }),
    ).toHaveTextContent('49,726 min');
    expect(
      screen.getByRole('region', { name: 'Daily spend for the last 30 days' }),
    ).toBeVisible();
    expect(screen.getByText('Spend today')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the call details tab in English without Chinese', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=cdrs`,
    );

    expect(await screen.findByText('Unverified only')).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: 'Export CSV' }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: 'Delete calls' }).length,
    ).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the rates tab in English without Chinese', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=rates`,
    );

    expect(await screen.findByText('Current effective version')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import CSV' })).toBeVisible();
    expect(screen.getByText('United Kingdom')).toBeVisible();
    expect(screen.getByText('Rate (¥/min)')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the balance history tab in English with the merged charge note', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=ledger`,
    );

    expect(
      (await screen.findAllByText('Current balance')).length,
    ).toBeGreaterThan(0);
    expect(await screen.findByText(/Filtered amount total/)).toBeVisible();
    expect(
      screen.getAllByText('01 Nov 2026 Call charges, 20 calls').length,
    ).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the statements tab in English without Chinese', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=statements`,
    );

    expect(await screen.findByText('Call details deleted')).toBeVisible();
    expect(
      screen.getAllByRole('link', { name: 'View Aug 2026' }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: 'Regenerate Aug 2026' }).length,
    ).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the statement detail in English without Chinese', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=statements&statementMonth=2026-08`,
    );

    expect(await screen.findByText('‹ Back to statements')).toBeVisible();
    expect(
      await screen.findByRole('button', { name: 'Export CSV (summary)' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Print' })).toBeVisible();
    expect(await screen.findByLabelText('Statement information')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the portal account tab in English without Chinese', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=portal`,
    );

    expect(
      await screen.findByRole('region', { name: 'Customer portal account' }),
    ).toBeVisible();
    expect(
      screen.getAllByRole('button', { name: 'Reset password' }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole('button', { name: 'Disable account' }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByText('Never signed in')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the settings tab in English without Chinese', async () => {
    const { container } = await renderPage(
      `/admin/tenants/${tenantId}?tab=settings`,
    );

    expect(
      await screen.findByRole('form', { name: 'Tenant settings' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Overdraft limit')).toHaveValue('100.00');
    expect(screen.getByLabelText('Low balance threshold')).toHaveValue(
      '200.00',
    );
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
