import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { decimal } from '@fs-billing/rating';
import {
  connections,
  createTenant,
  adminId,
  backendPid,
} from '../test/support.js';
import { lockTenants, withAdmin, withTenant } from './client.js';
import { ensureCdrPartitions } from './partitions.js';
import {
  tenants,
  balanceAlertSettings,
  cdrs,
  ledgerEntries,
  receivableSettlements,
  receivableSettlementReversals,
  receivableVoids,
} from './schema.js';
import { readTenantUsageOverview } from './usage.js';
import { getTenant, listTenants } from './admin/tenants.js';
import { adminTenantsQuerySchema } from '@fs-billing/shared';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureCdrPartitions(app.db, {
    moment: new Date('2026-08-01T00:00:00+08:00'),
    monthsAhead: 2,
  });
});

async function charge(tenantId: string, at: string, amount: string) {
  await withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    await tx.insert(ledgerEntries).values({
      tenantId,
      kind: 'call_charge',
      amount,
      idempotencyKey: randomUUID(),
      occurredAt: new Date(at),
    });
  });
}
async function call(
  tenantId: string,
  startedAt: string,
  answeredAt: string | null,
  minutes = '0',
  unverified = false,
) {
  const start = new Date(startedAt);
  const answer = answeredAt ? new Date(answeredAt) : null;
  await withAdmin(app.db, (tx) =>
    tx.insert(cdrs).values({
      tenantId,
      callUuid: randomUUID(),
      startedAt: start,
      answeredAt: answer,
      endedAt: new Date((answer ?? start).getTime() + 61000),
      caller: '1000',
      callee: '8613800138000',
      billingNumber: '8613800138000',
      durationSeconds: answer ? 61 : 0,
      billedMinutes: minutes,
      matchedPrefix: answer ? '86' : null,
      country: answer ? '中国' : null,
      rate: answer ? '0' : null,
      charge: '0',
      unverified,
      hangupCause: answer ? 'NORMAL_CLEARING' : 'CALL_REJECTED',
    }),
  );
}
const read = (tenantId: string, now: string) =>
  withAdmin(app.db, (tx) =>
    readTenantUsageOverview(tx, tenantId, new Date(now)),
  );

describe('tenant usage overview snapshot', () => {
  it('zero-fills days before a tenant created midway through the window', async () => {
    const tenantId = randomUUID();
    await withAdmin(owner.db, (tx) =>
      tx.insert(tenants).values({
        id: tenantId,
        code: `U${randomUUID().replaceAll('-', '')}`,
        name: 'mid-month',
        currency: 'CNY',
        overdraftLimit: '100',
        createdAt: new Date('2026-09-15T00:00:00+08:00'),
      }),
    );
    const value = await read(tenantId, '2026-09-30T15:59:59Z');
    expect(value.daily).toEqual(
      Array.from({ length: 30 }, (_, index) => ({
        date: `2026-09-${String(index + 1).padStart(2, '0')}`,
        spend: '0',
      })),
    );
    expect(value).toMatchObject({
      monthSpend: '0',
      monthCallMinutes: '0',
      answeredCalls: 0,
      unansweredCalls: 0,
      dailyTotal: '0',
    });
  });

  it('uses Beijing month and day edges, includes today, excludes future events and zero-fills exactly 30 days', async () => {
    const tenant = await createTenant(app, 'CNY');
    await charge(tenant.id, '2026-09-01T00:00:00+08:00', '-1.0001');
    await charge(tenant.id, '2026-09-30T15:59:59Z', '-2.0002');
    await charge(tenant.id, '2026-09-30T16:00:00Z', '-4.0004');
    await charge(tenant.id, '2026-10-01T00:00:01+08:00', '-999');
    await call(tenant.id, '2026-09-30T15:59:59Z', '2026-09-30T16:00:00Z', '2');
    await call(tenant.id, '2026-09-30T15:59:59Z', null);
    await call(tenant.id, '2026-09-30T16:00:00Z', null);
    await call(
      tenant.id,
      '2026-10-01T00:00:01+08:00',
      '2026-10-01T00:00:01+08:00',
      '99',
    );
    const before = await read(tenant.id, '2026-09-30T15:59:59Z');
    expect(before).toMatchObject({
      currency: 'CNY',
      monthSpend: '3.0003',
      monthCallMinutes: '0',
      answeredCalls: 0,
      unansweredCalls: 1,
      dailyTotal: '3.0003',
    });
    expect(before.daily).toHaveLength(30);
    expect(before.daily[0]).toEqual({ date: '2026-09-01', spend: '1.0001' });
    expect(before.daily[29]).toEqual({ date: '2026-09-30', spend: '2.0002' });
    expect(before.daily.slice(1, 29).every((day) => day.spend === '0')).toBe(
      true,
    );
    const after = await read(tenant.id, '2026-09-30T16:00:00Z');
    expect(after).toMatchObject({
      monthSpend: '4.0004',
      monthCallMinutes: '2',
      answeredCalls: 1,
      unansweredCalls: 1,
      dailyTotal: '6.0006',
    });
    expect(Date.parse(after.asOf)).toBe(Date.parse('2026-09-30T16:00:00Z'));
    expect(after.daily[0]).toEqual({ date: '2026-09-02', spend: '0' });
    expect(after.daily[29]).toEqual({ date: '2026-10-01', spend: '4.0004' });
    expect(
      after.daily
        .reduce((sum, day) => sum.plus(day.spend), decimal('0'))
        .toFixed(),
    ).toBe(after.dailyTotal);
  });

  it('counts billed minutes, unverified and zero-rate answers by answer time, and billing rejections by start time', async () => {
    const tenant = await createTenant(app, 'USD');
    await call(
      tenant.id,
      '2026-08-31T23:59:59+08:00',
      '2026-09-01T00:00:00+08:00',
      '2',
      true,
    );
    await call(
      tenant.id,
      '2026-09-02T12:00:00+08:00',
      '2026-09-02T12:00:01+08:00',
      '2',
    );
    await call(tenant.id, '2026-08-31T23:59:59+08:00', null);
    await call(tenant.id, '2026-09-02T12:00:00+08:00', null);
    await call(
      tenant.id,
      '2026-09-30T23:59:59+08:00',
      '2026-10-01T00:00:00+08:00',
      '2',
    );
    const value = await read(tenant.id, '2026-09-30T15:59:59Z');
    expect(value).toMatchObject({
      currency: 'USD',
      monthSpend: '0',
      monthCallMinutes: '4',
      answeredCalls: 2,
      unansweredCalls: 1,
      dailyTotal: '0',
    });
    expect(value.daily).toHaveLength(30);
    expect(value.daily.every((day) => day.spend === '0')).toBe(true);
  });

  it('ignores topups, gifts, adjustments, credit, void adjustments and settlement reversals', async () => {
    const tenant = await createTenant(app, 'CNY');
    const at = new Date('2026-09-15T12:00:00+08:00');
    await withAdmin(owner.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      const creditId = randomUUID();
      const voidAdjustment = randomUUID();
      const entries: Pick<
        typeof ledgerEntries.$inferInsert,
        'id' | 'kind' | 'amount' | 'createdBy'
      >[] = [
        { kind: 'call_charge', amount: '-0.123456789', createdBy: null },
        { kind: 'recharge', amount: '100', createdBy: administrator },
        { kind: 'gift', amount: '20', createdBy: administrator },
        { kind: 'adjustment', amount: '10', createdBy: administrator },
        { kind: 'adjustment', amount: '-5', createdBy: administrator },
        {
          id: creditId,
          kind: 'credit_recharge',
          amount: '50',
          createdBy: administrator,
        },
        {
          id: voidAdjustment,
          kind: 'adjustment',
          amount: '-50',
          createdBy: administrator,
        },
      ];
      await tx.insert(ledgerEntries).values(
        entries.map((entry) => ({
          ...entry,
          tenantId: tenant.id,
          note: '测试',
          idempotencyKey: randomUUID(),
          occurredAt: at,
          createdAt: at,
        })),
      );
      const settlementId = randomUUID();
      await tx.insert(receivableSettlements).values({
        id: settlementId,
        tenantId: tenant.id,
        ledgerEntryId: creditId,
        receivedOn: '2026-09-15',
        confirmedBy: administrator,
        createdAt: at,
      });
      await tx.insert(receivableSettlementReversals).values({
        tenantId: tenant.id,
        settlementId,
        reason: '撤销',
        reversedBy: administrator,
        createdAt: at,
      });
      await tx.insert(receivableVoids).values({
        tenantId: tenant.id,
        ledgerEntryId: creditId,
        adjustmentLedgerEntryId: voidAdjustment,
        reason: '作废',
        voidedBy: administrator,
        createdAt: at,
      });
    });
    const value = await read(tenant.id, '2026-09-30T15:59:59Z');
    expect(value.monthSpend).toBe('0.123456789');
    expect(value.dailyTotal).toBe('0.123456789');
    expect(value.daily.find((day) => day.date === '2026-09-15')).toEqual({
      date: '2026-09-15',
      spend: '0.123456789',
    });
  });

  it('enforces tenant RLS, matches admin month consumption, and runs in a read-only transaction without tenant locks', async () => {
    const a = await createTenant(app, 'CNY');
    const b = await createTenant(app, 'USD');
    await withAdmin(app.db, (tx) =>
      tx
        .insert(balanceAlertSettings)
        .values({ tenantId: a.id, threshold: '0', emails: [] }),
    );
    const now = new Date();
    await charge(a.id, now.toISOString(), '-0.5');
    await charge(b.id, now.toISOString(), '-999');
    const value = await app.db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      await tx.execute(
        sql`select set_config('app.scope', 'tenant', true), set_config('app.tenant_id', ${a.id}, true)`,
      );
      const result = await readTenantUsageOverview(tx, a.id, now);
      const locks = await owner.pool.query<{ locked: number }>(
        `select count(*)::int as locked from pg_locks
         where pid = $1 and locktype = 'advisory'`,
        [await backendPid(tx)],
      );
      expect(locks.rows).toEqual([{ locked: 0 }]);
      return result;
    });
    expect(
      await withTenant(app.db, a.id, (tx) =>
        readTenantUsageOverview(tx, a.id, now),
      ),
    ).toEqual(value);
    expect(value).toMatchObject({
      currency: 'CNY',
      monthSpend: '0.5',
      dailyTotal: '0.5',
    });
    expect(
      (await getTenant({ db: app.db, tenantId: a.id })).monthConsumption,
    ).toBe(value.monthSpend);
    const list = await listTenants({
      db: app.db,
      query: adminTenantsQuerySchema.parse({ search: a.code }),
    });
    expect(list.items[0]?.monthConsumption).toBe(value.monthSpend);
    await expect(
      withTenant(app.db, b.id, (tx) => readTenantUsageOverview(tx, a.id)),
    ).rejects.toMatchObject({ name: 'NotFoundError', code: 'NOT_FOUND' });
    await expect(read(randomUUID(), now.toISOString())).rejects.toMatchObject({
      name: 'NotFoundError',
      code: 'NOT_FOUND',
    });
  });

  it('inherits the started-time index on existing and newly created partitions', async () => {
    await ensureCdrPartitions(app.db, {
      moment: new Date('2035-01-15T00:00:00+08:00'),
      monthsAhead: 0,
    });
    const { rows } = await owner.pool.query<{ partition: string }>(`
      select t.relname as partition from pg_inherits i
      join pg_index x on x.indexrelid = i.inhrelid
      join pg_class t on t.oid = x.indrelid
      where i.inhparent = 'cdrs_tenant_started_at'::regclass
    `);
    expect(rows.map((row) => row.partition)).toEqual(
      expect.arrayContaining(['cdrs_2026_09', 'cdrs_2035_01']),
    );
  });
});
