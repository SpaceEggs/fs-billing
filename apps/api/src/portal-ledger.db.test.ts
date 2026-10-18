import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { withAdmin, appendLedgerEntry, operateBalance } from '@fs-billing/db';
import { money } from '@fs-billing/rating';
import {
  adminLedgerResponseSchema,
  portalLedgerResponseSchema,
} from '@fs-billing/shared';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let customerCookie: string;
let adminCookie: string;
const sentinel = 'PRIVATE-NOTE-DO-NOT-EXPOSE-' + randomUUID();
const range = () => {
  const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `from=${day.slice(0, 7)}-01&to=${day}`;
};
beforeAll(async () => {
  fixture = await createFixture(connections);
  customerCookie = (await login(api, fixture.a)).cookie;
  adminCookie = (await login(api, fixture.admin)).cookie;
  if (!fixture.a.tenantId) throw new Error('missing tenant');
  await operateBalance({
    db: connections.app.db,
    actor: { id: fixture.admin.profileId, name: 'admin' },
    tenantId: fixture.a.tenantId,
    request: {
      kind: 'credit_topup',
      currency: 'CNY',
      amount: '25.5',
      internalNote: sentinel,
      idempotencyKey: randomUUID(),
    },
  });
  await withAdmin(connections.app.db, (tx) =>
    appendLedgerEntry(
      tx,
      { id: fixture.a.tenantId ?? '', currency: 'CNY' },
      {
        kind: 'call_charge',
        amount: money('CNY', '-1.25'),
        note: '',
        idempotencyKey: randomUUID(),
        occurredAt: new Date(),
      },
    ),
  );
});

describe('portal and admin ledger HTTP boundary', () => {
  it('shows a credit recharge as a recharge with the account recharge note and leaks no internal JSON keys or values', async () => {
    const response = await api.inject({
      url: `/api/portal/ledger?${range()}&kind=recharge`,
      headers: requestHeaders(customerCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    for (const secret of [
      'credit_recharge',
      'paymentStatus',
      'noteVisibility',
      'actor',
      'createdBy',
      'internalNote',
      sentinel,
      fixture.admin.profileId,
    ])
      expect(response.body).not.toContain(secret);
    const body = portalLedgerResponseSchema.parse(response.json());
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'recharge',
          amount: '25.5',
          note: '账户充值',
        }),
      ]),
    );
    expect(body.pagination.total).toBe(2);
    expect(body.totalAmount).toBe('136.75');
    expect(body.balance).toBe('135.50');
  });
  it('adds payment status, actor and internal note for admins only', async () => {
    const response = await api.inject({
      url: `/api/admin/tenants/${fixture.a.tenantId}/ledger?${range()}`,
      headers: requestHeaders(adminCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = adminLedgerResponseSchema.parse(response.json());
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'credit_recharge',
          amount: '25.5',
          note: sentinel,
          noteVisibility: 'admin',
          paymentStatus: 'pending',
          actor: { id: fixture.admin.profileId, name: 'admin' },
        }),
      ]),
    );
    expect(
      body.items.filter((row) => row.kind === 'call_charge'),
    ).toMatchObject([{ calls: 1, partial: true }]);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('rejects invalid ranges, timestamps, unknown filters and missing dates with 400', async () => {
    for (const filters of [
      '',
      'from=2026-09-01&to=2026-10-01',
      'from=2026-09-30&to=2026-09-01',
      'from=2026-02-30&to=2026-02-30',
      'from=2026-09-01T00:00:00Z&to=2026-09-30',
      `${range()}&unverified=true`,
      `${range()}&tenantId=${fixture.b.tenantId}`,
      `${range()}&kind=credit_recharge`,
    ]) {
      const response = await api.inject({
        url: `/api/portal/ledger?${filters}`,
        headers: requestHeaders(customerCookie),
      });
      expect(response.statusCode, filters).toBe(400);
    }
  });
  it('returns empty items with totals for pages beyond the last page', async () => {
    const response = await api.inject({
      url: `/api/portal/ledger?${range()}&page=99`,
      headers: requestHeaders(customerCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(portalLedgerResponseSchema.parse(response.json())).toMatchObject({
      items: [],
      pagination: { total: 3 },
      totalAmount: '135.50',
    });
  });
  it('rejects admin sessions at the portal route and absent sessions', async () => {
    expect(
      (
        await api.inject({
          url: `/api/portal/ledger?${range()}`,
          headers: requestHeaders(adminCookie),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await api.inject({ url: `/api/portal/ledger?${range()}` })).statusCode,
    ).toBe(401);
  });
  it('maps a missing admin tenant to 404', async () => {
    const response = await api.inject({
      url: `/api/admin/tenants/${randomUUID()}/ledger?${range()}`,
      headers: requestHeaders(adminCookie),
    });
    expect(response.statusCode, response.body).toBe(404);
  });
  it('keeps raw query projection free of actor and receivable reads for customer scope', async () => {
    // RLS denies the portal identity direct access to the administrator and receivable tables.
    // This executes the same projection with the customer scope and proves it succeeds.
    const response = await api.inject({
      url: `/api/portal/ledger?${range()}`,
      headers: requestHeaders(customerCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = portalLedgerResponseSchema.parse(response.json());
    expect(body.items.find((row) => row.kind === 'call_charge')).toMatchObject({
      amount: '-1.25',
    });
  });
});
