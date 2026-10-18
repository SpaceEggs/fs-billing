import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminLedgerQuerySchema,
  portalLedgerQuerySchema,
  portalLedgerResponseSchema,
} from '@fs-billing/shared';
import { adminId, connections, createTenant } from '../test/support.js';
import { lockTenants, withAdmin, withTenant } from './client.js';
import { mergedLedgerSql, type LedgerAnchor } from './ledger-merge.js';
import { listPortalLedger } from './portal/ledger.js';
import { listTenantLedger, operateBalance } from './admin/balance.js';
import { writeAudit } from './admin/audit.js';

const { app, owner } = connections();
let tenantId: string;
let actorId: string;
const ids = {
  early: '10000000-0000-4000-8000-000000000001',
  manual: '20000000-0000-4000-8000-000000000001',
  last: '30000000-0000-4000-8000-000000000001',
  later: '40000000-0000-4000-8000-000000000001',
};
async function entry({
  id = randomUUID(),
  kind = 'call_charge',
  amount,
  at,
  createdAt = at,
}: {
  id?: string;
  kind?: 'recharge' | 'gift' | 'adjustment' | 'call_charge';
  amount: string;
  at: string;
  createdAt?: string;
}) {
  await withAdmin(owner.db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    await tx.execute(sql`insert into ledger_entries
      (id, tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
      values (${id}::uuid, ${tenantId}::uuid, ${kind}, ${amount}, '',
        ${kind === 'call_charge' ? null : actorId}::uuid, ${id}, ${at}::timestamptz, ${createdAt}::timestamptz)`);
  });
}
const query = (fields = {}) =>
  portalLedgerQuerySchema.parse({
    from: '2026-09-01',
    to: '2026-09-30',
    ...fields,
  });
const list = (fields = {}) =>
  listPortalLedger({ db: app.db, tenantId, query: query(fields) });
beforeAll(async () => {
  tenantId = (await createTenant(owner, 'CNY')).id;
  actorId = await adminId(owner);
  await entry({ kind: 'recharge', amount: '100', at: '2026-08-01T00:00:00Z' });
  await entry({ id: ids.early, amount: '-1', at: '2026-09-23T01:00:00Z' });
  await entry({ amount: '-2', at: '2026-09-23T04:00:00Z' });
  await entry({
    id: ids.manual,
    kind: 'recharge',
    amount: '50',
    at: '2026-09-23T07:00:00Z',
  });
  await entry({ id: ids.last, amount: '-3', at: '2026-09-23T07:00:00Z' });
  await entry({
    id: ids.later,
    kind: 'gift',
    amount: '5',
    at: '2026-09-23T07:00:00Z',
  });
  await entry({ amount: '-4', at: '2026-09-28T16:30:00Z' });
  await entry({
    amount: '-7',
    at: '2026-09-30T15:59:00Z',
    createdAt: '2026-09-30T16:00:30Z',
  });
});

describe('merged ledger', () => {
  it('places the merged row at the last charge of the day and chains balances row by row', async () => {
    const result = await list({ from: '2026-09-23', to: '2026-09-23' });
    expect(result.items).toMatchObject([
      { kind: 'gift', amount: '5', balanceAfter: '149' },
      {
        kind: 'call_charge',
        day: '2026-09-23',
        calls: 3,
        amount: '-6',
        balanceAfter: '144',
        occurredAt: '2026-09-23T07:00:00.000000Z',
      },
      { kind: 'recharge', amount: '50', balanceAfter: '150' },
    ]);
    expect(result.balance).toBe('138');
  });
  it('orders a manual entry and the last charge of the day at the same instant by id', async () => {
    const { items } = await list({ from: '2026-09-23', to: '2026-09-23' });
    expect(items.map((row) => row.kind)).toEqual([
      'gift',
      'call_charge',
      'recharge',
    ]);
    const { rows } = await owner.pool.query<{ balance: string }>(
      `select sum(amount)::text as balance from ledger_entries where tenant_id=$1 and (occurred_at,id)<=('2026-09-23T07:00Z',$2::uuid)`,
      [tenantId, ids.last],
    );
    expect(items[1]?.balanceAfter).toBe(rows[0]?.balance);
  });
  it('type filter keeps the running balance of the unfiltered list', async () => {
    expect((await list({ kind: 'recharge' })).items).toMatchObject([
      { amount: '50', balanceAfter: '150' },
    ]);
    expect((await list({ kind: 'call_charge' })).totalAmount).toBe('-17');
  });
  it('returns total and totalAmount for an empty filter result and an out-of-range page', async () => {
    expect(await list({ kind: 'adjustment' })).toMatchObject({
      items: [],
      totalAmount: '0',
      pagination: { total: 0 },
    });
    expect(await list({ page: 100 })).toMatchObject({
      items: [],
      totalAmount: '38',
      pagination: { total: 5 },
    });
  });
  it('puts a charge at UTC 2026-09-28 16:30 on the 29th', async () => {
    expect(
      (await list({ from: '2026-09-28', to: '2026-09-28' })).items,
    ).toEqual([]);
    expect(
      (await list({ from: '2026-09-29', to: '2026-09-29' })).items,
    ).toMatchObject([{ day: '2026-09-29', amount: '-4' }]);
  });
  it('groups charges by the Beijing day of occurred_at and not created_at', async () => {
    expect(
      (await list({ from: '2026-09-30', to: '2026-09-30' })).items,
    ).toMatchObject([{ day: '2026-09-30', amount: '-7' }]);
    expect(
      (await list({ from: '2026-10-01', to: '2026-10-01' })).items,
    ).toEqual([]);
  });
  it('accepts from 0001-01-01 and returns only the rows inside that Beijing day', async () => {
    await entry({ amount: '-0.01', at: '0001-01-01T12:00:00Z' });
    const result = await list({ from: '0001-01-01', to: '0001-01-01' });
    expect(result.items).toMatchObject([
      { day: '0001-01-01', amount: '-0.01', balanceAfter: '-0.01' },
    ]);
  });
  it('both anchors give the same balances in every month of the fixture', async () => {
    for (const [from, to] of [
      ['0001-01-01', '0001-01-31'],
      ['2026-08-01', '2026-08-31'],
      ['2026-09-01', '2026-09-30'],
      ['2026-10-01', '2026-10-31'],
    ]) {
      const results = [];
      for (const anchor of ['prior', 'balance'] satisfies LedgerAnchor[])
        results.push(
          await withTenant(app.db, tenantId, async (tx) => {
            const { rows } = await tx.execute<{ ledger: unknown }>(
              mergedLedgerSql({
                tenantId,
                query: query({ from, to }),
                pageSize: 25,
                audience: 'portal',
                anchor,
              }),
            );
            return portalLedgerResponseSchema.parse(rows[0]?.ledger);
          }),
        );
      expect(results[0]).toEqual(results[1]);
    }
  });
  it("marks only today's row as partial", async () => {
    const { rows } = await owner.pool.query<{ today: string; at: string }>(
      `select (statement_timestamp() at time zone 'Asia/Shanghai')::date::text as today, to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`,
    );
    const today = rows[0];
    if (!today) throw new Error('clock unavailable');
    await entry({ amount: '-1', at: today.at });
    expect(
      (await list({ from: today.today, to: today.today })).items,
    ).toMatchObject([{ partial: true }]);
    expect(
      (await list()).items.every(
        (row) => row.kind !== 'call_charge' || !row.partial,
      ),
    ).toBe(true);
  });
  it('admin and portal agree on every merged row', async () => {
    const portal = await list();
    const admin = await listTenantLedger({
      db: app.db,
      tenantId,
      query: adminLedgerQuerySchema.parse(query()),
    });
    expect(admin.items.filter((row) => row.kind === 'call_charge')).toEqual(
      portal.items.filter((row) => row.kind === 'call_charge'),
    );
    expect(admin.totalAmount).toBe(portal.totalAmount);
    expect(admin.balance).toBe(portal.balance);
  });
  it('keeps microsecond precision when replaying a single balance operation', async () => {
    const tenant = await createTenant(owner, 'CNY');
    const id = randomUUID();
    const key = randomUUID();
    const auditId = randomUUID();
    await withAdmin(owner.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(sql`insert into ledger_entries
        (id, tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
        values (${id}::uuid, ${tenant.id}::uuid, 'recharge', 25, '', ${actorId}::uuid, ${key},
          '2026-09-23T07:00:00.123456Z', '2026-09-23T07:00:00.123456Z'),
        (gen_random_uuid(), ${tenant.id}::uuid, 'gift', 10, '', ${actorId}::uuid, ${randomUUID()},
          '2026-09-23T07:00:00.123999Z', '2026-09-23T07:00:00.123999Z')`);
      await writeAudit(tx, {
        id: auditId,
        actor: { id: actorId, name: '管理员' },
        occurredAt: '2026-09-23T07:00:00.123456Z',
        tenantId: tenant.id,
        target: { kind: 'ledger_entry', id },
        action: 'balance_topup',
        content: {
          summary: '人工余额操作',
          changes: [],
          ledgerEntryId: id,
          amount: '25',
          currency: 'CNY',
        },
      });
    });
    const result = await operateBalance({
      db: app.db,
      actor: { id: actorId, name: '管理员' },
      tenantId: tenant.id,
      request: {
        kind: 'topup',
        currency: 'CNY',
        amount: '25',
        note: '',
        idempotencyKey: key,
      },
    });
    expect(result.entry.balanceAfter).toBe('25');
    expect(result.balance).toBe('35');
    expect(result.auditId).toBe(auditId);
  });
  it('does not read internal fields in the portal SQL', () => {
    const text = new PgDialect().sqlToQuery(
      mergedLedgerSql({
        tenantId,
        query: query(),
        pageSize: 25,
        audience: 'portal',
      }),
    ).sql;
    // The executable boundary is also checked by raw HTTP JSON tests.
    expect(text).not.toContain('receivables');
    expect(text).not.toContain('created_by');
  });
});
