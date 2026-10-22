import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PORTAL_HOME_RECENT_CALLS } from '@fs-billing/shared';
import { adminId, connections, createTenant } from '../../test/support.js';
import { lockTenants, withAdmin } from '../client.js';
import { NotFoundError } from '../errors.js';
import { ensureCdrPartitions } from '../partitions.js';
import {
  balanceAlertSettings,
  cdrs,
  ledgerEntries,
  tenants,
} from '../schema.js';
import { readTenantUsageOverview } from '../usage.js';
import { readPortalHome } from './home.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureCdrPartitions(app.db, {
    moment: new Date('2026-06-01T00:00:00+08:00'),
    monthsAhead: 4,
  });
});

async function ledger(
  tenantId: string,
  kind: 'call_charge' | 'recharge',
  amount: string,
  at: string,
) {
  await withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    await tx.insert(ledgerEntries).values({
      tenantId,
      kind,
      amount,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(at),
      ...(kind === 'recharge'
        ? {
            createdBy: administrator,
            note: '测试',
            createdAt: new Date(at),
          }
        : {}),
    });
  });
}

async function call(
  tenantId: string,
  startedAt: string,
  answeredAt: string | null,
  {
    minutes = '1',
    unverified = false,
    callee = '8613800138000',
  }: { minutes?: string; unverified?: boolean; callee?: string } = {},
) {
  const start = new Date(startedAt);
  const answer = answeredAt ? new Date(answeredAt) : null;
  const callUuid = randomUUID();
  await withAdmin(app.db, (tx) =>
    tx.insert(cdrs).values({
      tenantId,
      callUuid,
      startedAt: start,
      answeredAt: answer,
      endedAt: new Date((answer ?? start).getTime() + 61_000),
      caller: '1000',
      callee,
      billingNumber: callee.replace(/\D/g, ''),
      durationSeconds: answer ? 61 : 0,
      billedMinutes: answer ? minutes : '0',
      matchedPrefix: answer ? '86' : null,
      country: answer ? '中国' : null,
      iso: answer ? 'CN' : null,
      description: answer ? '手机' : null,
      rate: answer ? '0.0500' : null,
      charge: answer ? '0.05' : '0',
      unverified,
      hangupCause: answer ? 'NORMAL_CLEARING' : 'CALL_REJECTED',
    }),
  );
  return callUuid;
}

const home = (tenantId: string, now?: string) =>
  readPortalHome({
    db: app.db,
    tenantId,
    ...(now ? { now: new Date(now) } : {}),
  });

describe('portal home', () => {
  it('matches the admin overview figures', async () => {
    const tenant = await createTenant(app, 'CNY');
    await ledger(tenant.id, 'call_charge', '-1.5', '2026-09-01T00:00:00+08:00');
    await ledger(
      tenant.id,
      'call_charge',
      '-2.25',
      '2026-09-15T12:00:00+08:00',
    );
    await ledger(tenant.id, 'call_charge', '-4', '2026-09-30T15:59:59Z');
    await ledger(tenant.id, 'call_charge', '-999', '2026-10-01T00:00:01+08:00');
    await call(
      tenant.id,
      '2026-08-31T23:59:59+08:00',
      '2026-09-01T00:00:00+08:00',
      {
        minutes: '2',
        unverified: true,
      },
    );
    await call(
      tenant.id,
      '2026-09-15T11:59:00+08:00',
      '2026-09-15T12:00:00+08:00',
      {
        minutes: '3',
      },
    );
    await call(tenant.id, '2026-09-20T10:00:00+08:00', null);
    const now = '2026-09-30T15:59:59Z';

    const result = await home(tenant.id, now);
    const admin = await withAdmin(app.db, (tx) =>
      readTenantUsageOverview(tx, tenant.id, new Date(now)),
    );

    const { currency, unansweredCalls, ...shared } = admin;
    expect(result.usage).toEqual(shared);
    expect(result.currency).toBe(currency);
    expect(unansweredCalls).toBe(1);
    expect(result.usage).not.toHaveProperty('unansweredCalls');
    expect(result.usage.answeredCalls).toBe(2);
    expect(result.usage.monthCallMinutes).toBe('5');
    expect(result.usage.monthSpend).toBe('7.75');
  });

  it.each([
    {
      state: 'normal',
      health: 'normal',
      balance: '0',
      available: '100.00',
    },
    {
      state: 'low balance',
      health: 'low_balance',
      balance: '20',
      available: '120.00',
      threshold: '50',
    },
    {
      state: 'overdraft',
      health: 'overdraft',
      balance: '-35.2',
      available: '64.80',
    },
    {
      state: 'suspended',
      health: 'suspended',
      balance: '-100',
      available: '0.00',
    },
    {
      state: 'disabled',
      health: 'disabled',
      balance: '-100',
      available: '0.00',
      disabled: true,
    },
  ] as const)(
    'reports a $state tenant as $health with its balance, overdraft limit and available balance',
    async (row) => {
      const tenant = await createTenant(app, 'CNY');
      if (row.threshold !== undefined)
        await withAdmin(app.db, (tx) =>
          tx.insert(balanceAlertSettings).values({
            tenantId: tenant.id,
            threshold: row.threshold,
            emails: [],
          }),
        );
      const negative = row.balance.startsWith('-');
      const positive = !negative && /[1-9]/.test(row.balance);
      if (positive)
        await ledger(
          tenant.id,
          'recharge',
          row.balance,
          '2026-09-10T10:00:00Z',
        );
      if (negative)
        await ledger(
          tenant.id,
          'call_charge',
          row.balance,
          '2026-09-10T10:00:00Z',
        );
      if (row.disabled)
        await withAdmin(app.db, (tx) =>
          tx
            .update(tenants)
            .set({ status: 'disabled' })
            .where(eq(tenants.id, tenant.id)),
        );

      const result = await home(tenant.id, '2026-09-30T15:59:59Z');

      expect(result).toMatchObject({
        currency: 'CNY',
        health: row.health,
        balance: row.balance,
        overdraftLimit: '100.00',
        availableBalance: row.available,
      });
    },
  );

  it('lists the newest answered calls, at most 10, without the unverified flag', async () => {
    const tenant = await createTenant(app, 'CNY');
    const answered: string[] = [];
    for (let minute = 0; minute < PORTAL_HOME_RECENT_CALLS + 2; minute++) {
      const at = new Date(Date.UTC(2026, 8, 20, 8, minute));
      answered.push(
        await call(
          tenant.id,
          new Date(at.getTime() - 5000).toISOString(),
          at.toISOString(),
          {
            unverified: minute === 3,
          },
        ),
      );
    }
    await call(tenant.id, '2026-09-21T08:00:00Z', null);

    const result = await home(tenant.id, '2026-09-30T00:00:00Z');

    expect(result.recentCalls.map((item) => item.callUuid)).toEqual(
      answered.slice(2).reverse(),
    );
    expect(result.recentCalls.every((item) => item.answeredAt)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/unverified/i);
    expect(result.recentCalls[0]).toMatchObject({
      callee: '8613800138000',
      country: '中国',
      iso: 'CN',
      description: '手机',
      durationSeconds: 61,
      billedMinutes: '1',
      rate: '0.0500',
      charge: '0.05',
    });

    // 最近话单没有日期下界：几个月前的话单照样出现。
    const sparse = await createTenant(app, 'CNY');
    const oldOnly = await call(
      sparse.id,
      '2026-06-01T08:00:00Z',
      '2026-06-01T08:00:05Z',
    );
    const sparseHome = await home(sparse.id, '2026-09-30T00:00:00Z');
    expect(sparseHome.recentCalls.map((item) => item.callUuid)).toEqual([
      oldOnly,
    ]);
  });

  it('returns an empty recent list and a zero window for a tenant without calls', async () => {
    const tenant = await createTenant(app, 'USD');

    const result = await home(tenant.id, '2026-09-30T15:59:59Z');

    expect(result.recentCalls).toEqual([]);
    expect(result.usage).toMatchObject({
      monthSpend: '0',
      monthCallMinutes: '0',
      answeredCalls: 0,
      dailyTotal: '0',
    });
    expect(result.usage.daily).toHaveLength(30);
    expect(result).toMatchObject({ currency: 'USD', health: 'normal' });
  });

  it('shows each tenant only its own figures', async () => {
    const a = await createTenant(app, 'CNY');
    const b = await createTenant(app, 'USD');
    await ledger(a.id, 'recharge', '111.25', '2026-09-10T10:00:00Z');
    await ledger(b.id, 'recharge', '999.75', '2026-09-10T10:00:00Z');
    const callA = await call(
      a.id,
      '2026-09-10T10:00:00Z',
      '2026-09-10T10:00:05Z',
    );
    const callB = await call(
      b.id,
      '2026-09-10T10:00:00Z',
      '2026-09-10T10:00:05Z',
    );

    const homeA = await home(a.id, '2026-09-30T00:00:00Z');
    const homeB = await home(b.id, '2026-09-30T00:00:00Z');

    expect(homeA).toMatchObject({ currency: 'CNY', balance: '111.25' });
    expect(homeA.recentCalls.map((item) => item.callUuid)).toEqual([callA]);
    expect(homeB).toMatchObject({ currency: 'USD', balance: '999.75' });
    expect(homeB.recentCalls.map((item) => item.callUuid)).toEqual([callB]);
  });

  it('throws NotFoundError for a tenant the session cannot see', async () => {
    await expect(home(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
