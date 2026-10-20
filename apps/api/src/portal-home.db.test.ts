import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appendLedgerEntry,
  ensureCdrPartitions,
  withAdmin,
} from '@fs-billing/db';
import { money } from '@fs-billing/rating';
import { apiErrorSchema, portalHomeResponseSchema } from '@fs-billing/shared';
import * as identity from './identity.js';
import { principalSchema } from './types.js';
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

beforeAll(async () => {
  fixture = await createFixture(connections);
  customerCookie = (await login(api, fixture.a)).cookie;
  adminCookie = (await login(api, fixture.admin)).cookie;
  const tenantId = fixture.a.tenantId ?? '';
  await ensureCdrPartitions(connections.owner.db, { moment: new Date() });
  const answeredAt = new Date();
  await connections.owner.pool.query(
    `insert into public.cdrs
       (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
        billing_number, duration_seconds, billed_minutes, matched_prefix, country,
        rate, charge, hangup_cause, unverified, iso, description)
     values ($1,$2,$3,$4,$5,'1001','+447700900123','447700900123',61,2,'44','英国',
       0.2,1.25,'NORMAL_CLEARING',true,'GB','手机')`,
    [
      tenantId,
      randomUUID(),
      new Date(answeredAt.getTime() - 5000),
      answeredAt,
      new Date(answeredAt.getTime() + 61_000),
    ],
  );
  await withAdmin(connections.app.db, (tx) =>
    appendLedgerEntry(
      tx,
      { id: tenantId, currency: 'CNY' },
      {
        kind: 'call_charge',
        amount: money('CNY', '-1.25'),
        note: '',
        idempotencyKey: randomUUID(),
        occurredAt: answeredAt,
      },
    ),
  );
});

afterEach(() => vi.restoreAllMocks());

describe('GET /api/portal/home', () => {
  it('returns the signed-in tenant balance, 30-day usage and recent answered calls', async () => {
    const response = await api.inject({
      url: '/api/portal/home',
      headers: requestHeaders(customerCookie),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = portalHomeResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      currency: 'CNY',
      balance: '110.00',
      overdraftLimit: '100',
      availableBalance: '210.00',
      health: 'normal',
      usage: { monthSpend: '1.25', answeredCalls: 1, dailyTotal: '1.25' },
    });
    expect(body.usage.daily.at(-1)).toMatchObject({ spend: '1.25' });
    expect(body.recentCalls).toMatchObject([
      {
        callee: '+447700900123',
        country: '英国',
        iso: 'GB',
        description: '手机',
        billedMinutes: '2',
        charge: '1.25',
      },
    ]);
  });

  it('leaks neither the unverified flag nor the unanswered count in the raw JSON', async () => {
    const response = await api.inject({
      url: '/api/portal/home',
      headers: requestHeaders(customerCookie),
    });

    expect(response.body).not.toMatch(/unverified/i);
    expect(response.body).not.toContain('unansweredCalls');
  });

  it('rejects an admin session and an anonymous request', async () => {
    const admin = await api.inject({
      url: '/api/portal/home',
      headers: requestHeaders(adminCookie),
    });
    const anonymous = await api.inject({ url: '/api/portal/home' });

    expect(admin.statusCode).toBe(403);
    expect(apiErrorSchema.parse(admin.json()).error.code).toBe('FORBIDDEN');
    expect(anonymous.statusCode).toBe(401);
  });

  it('answers NOT_FOUND when the tenant is not visible to the session', async () => {
    const tenantId = randomUUID();
    const principal = principalSchema.parse({
      kind: 'customer',
      authUserId: fixture.a.userId,
      profileId: fixture.a.profileId,
      tenantId,
    });
    if (principal.kind !== 'customer') throw new Error('Expected a customer');
    vi.spyOn(identity, 'resolvePrincipal').mockResolvedValue({
      kind: 'customer',
      principal,
      identity: {
        kind: 'customer',
        profileId: fixture.a.profileId,
        email: fixture.a.email,
        tenant: { id: tenantId, code: 'GONE', name: 'Gone', currency: 'CNY' },
      },
    });

    const response = await api.inject({
      url: '/api/portal/home',
      headers: requestHeaders(customerCookie),
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});
