import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  beijingMonth,
  beijingTime,
  parseDialedNumber,
} from '@fs-billing/rating';
import { adminTransaction, connections, deferred } from '../test/support.js';
import { ensureStatementPartitions } from '../test/statements.js';
import { chargedCall, rateTenant } from '../test/unassigned.js';
import {
  CdrMonthDeletedError,
  cdrMonthStart,
  chargeCall,
  isMonthDeleted,
  loadDeletedMonths,
  priceAndInsertCdr,
  type IntakeCdr,
} from './cdr-intake.js';
import { lockTenants, withAdmin, withSystem } from './client.js';
import { loadRatingTenant } from './rates.js';

const { app, owner } = connections();
beforeAll(async () => {
  await ensureStatementPartitions(app);
});

const billing = parseDialedNumber('8613800138000')!;

function call(overrides: Partial<IntakeCdr> = {}): IntakeCdr {
  const answeredAt =
    overrides.answeredAt === undefined
      ? beijingTime('2026-09-10 10:00:00')
      : overrides.answeredAt;
  return {
    callUuid: randomUUID(),
    startedAt: new Date(
      (answeredAt ?? beijingTime('2026-09-10 10:00:00')).getTime() - 5_000,
    ),
    answeredAt,
    endedAt: new Date(
      (answeredAt ?? beijingTime('2026-09-10 10:00:00')).getTime() + 61_000,
    ),
    caller: '075586001234',
    callee: '+8613800138000',
    billsec: answeredAt ? 61 : 0,
    hangupCause: 'NORMAL_CLEARING',
    unverified: false,
    ...overrides,
  };
}

async function deleteMonth(tenantId: string, month: string) {
  await owner.pool.query(
    `insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift, adjustment,
                                     call_charges, closing_balance, call_minutes)
     values ($1, $2, 0, 0, 0, 0, 0, 0, 0) on conflict (tenant_id, month) do nothing`,
    [tenantId, month],
  );
  await owner.pool.query(
    `update monthly_statements set details_deleted = true where tenant_id = $1 and month = $2`,
    [tenantId, month],
  );
}

/** 一次入库：租户锁、读费率表、定价写 cdrs（Worker 的 HTTP 入库做的事）。 */
async function intake(tenant: { id: string; code: string }, cdr: IntakeCdr) {
  return withSystem(app.db, async (tx) => {
    await lockTenants(tx, [tenant.id]);
    const rating = await loadRatingTenant(tx, tenant.code);
    return priceAndInsertCdr(tx, { id: tenant.id, rating }, cdr, billing);
  });
}

describe('入库定价与扣费的共享函数', () => {
  it('cdrMonthStart agrees with the database month of coalesce(answered_at, started_at) at the Beijing boundaries', async () => {
    const instants = [
      '2026-08-31T15:59:59.999Z',
      '2026-08-31T16:00:00.000Z',
      '2026-09-30T15:59:59.999Z',
      '2026-09-30T16:00:00.000Z',
      '2026-12-31T16:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ].map((text) => new Date(text));
    for (const instant of instants) {
      const { rows } = await owner.pool.query<{ month: string }>(
        `select to_char(date_trunc('month', $1::timestamptz at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as month`,
        [instant],
      );
      expect(cdrMonthStart({ startedAt: instant, answeredAt: null })).toBe(
        rows[0]!.month,
      );
      expect(
        cdrMonthStart({ startedAt: new Date(0), answeredAt: instant }),
      ).toBe(rows[0]!.month);
      expect(rows[0]!.month.slice(0, 7)).toBe(beijingMonth(instant));
    }
  });

  it('writes the rate snapshot for an answered call and a bare row for an unanswered one', async () => {
    const tenant = await rateTenant(owner);
    const answered = call();
    const unanswered = call({ answeredAt: null });
    const first = await intake(tenant, answered);
    const second = await intake(tenant, unanswered);
    expect(first).toMatchObject({ status: 'inserted' });
    expect(first.status === 'inserted' && first.charge.toFixed()).toBe('0.1');
    expect(first.status === 'inserted' && first.billedMinutes.toFixed()).toBe(
      '2',
    );
    expect(second.status === 'inserted' && second.charge.toFixed()).toBe('0');
    expect(
      (
        await owner.pool.query(
          `select call_uuid::text, matched_prefix, country, rate::text, charge::text, billed_minutes::text, answered_at is null as unanswered
           from cdrs where tenant_id = $1 order by unanswered`,
          [tenant.id],
        )
      ).rows,
    ).toEqual([
      {
        call_uuid: answered.callUuid,
        matched_prefix: '86',
        country: '中国',
        rate: '0.05',
        charge: '0.1',
        billed_minutes: '2',
        unanswered: false,
      },
      {
        call_uuid: unanswered.callUuid,
        matched_prefix: null,
        country: null,
        rate: null,
        charge: '0',
        billed_minutes: '0',
        unanswered: true,
      },
    ]);
  });

  it('returns no_rate without writing when no rate applies at the answer time', async () => {
    const tenant = await rateTenant(owner, {
      firstRateAt: '2026-06-01 00:00:00',
    });
    const result = await intake(
      tenant,
      call({ answeredAt: beijingTime('2026-05-20 10:00:00') }),
    );
    expect(result).toEqual({ status: 'no_rate' });
    expect(
      (
        await owner.pool.query('select 1 from cdrs where tenant_id = $1', [
          tenant.id,
        ])
      ).rows,
    ).toEqual([]);
  });

  it('returns month_deleted for a deleted month and writes nothing', async () => {
    const tenant = await rateTenant(owner);
    await deleteMonth(tenant.id, '2026-07-01');
    const julyCall = call({ answeredAt: beijingTime('2026-07-15 10:00:00') });
    expect(await intake(tenant, julyCall)).toEqual({
      status: 'month_deleted',
      month: '2026-07-01',
    });
    // 未接通话单按开始时间归月。
    expect(
      await intake(tenant, {
        ...call({ answeredAt: null }),
        startedAt: beijingTime('2026-07-20 10:00:00'),
        endedAt: beijingTime('2026-07-20 10:00:20'),
      }),
    ).toEqual({ status: 'month_deleted', month: '2026-07-01' });
    // 相邻月份不受影响。
    expect((await intake(tenant, call())).status).toBe('inserted');
    expect(
      (
        await owner.pool.query(
          'select count(*)::int as n from cdrs where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    expect(
      await withAdmin(app.db, async (tx) => ({
        months: [...(await loadDeletedMonths(tx, tenant.id))],
        july: await isMonthDeleted(tx, tenant.id, '2026-07-01'),
        august: await isMonthDeleted(tx, tenant.id, '2026-08-01'),
      })),
    ).toEqual({ months: ['2026-07-01'], july: true, august: false });
  });

  it('rechecks the deleted flag after the tenant lock is granted', async () => {
    const tenant = await rateTenant(owner);
    await owner.pool.query(
      `insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift, adjustment,
                                       call_charges, closing_balance, call_minutes)
       values ($1, '2026-07-01', 0, 0, 0, 0, 0, 0, 0)`,
      [tenant.id],
    );
    const locked = deferred();
    const release = deferred();
    // 删除话单的事务：持租户锁，置标志，稍后提交。
    const deleter = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(
        sql`update monthly_statements set details_deleted = true where tenant_id = ${tenant.id}::uuid and month = '2026-07-01'`,
      );
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    // 入库的事务：在拿到租户锁之前，标志还没有提交；拿到锁之后读到的必须是已提交的。
    const attempt = intake(
      tenant,
      call({ answeredAt: beijingTime('2026-07-15 10:00:00') }),
    );
    const early = await Promise.race([
      attempt.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(early).toBe('waiting');
    release.resolve();
    await deleter;
    expect(await attempt).toEqual({
      status: 'month_deleted',
      month: '2026-07-01',
    });
    expect(
      (
        await owner.pool.query('select 1 from cdrs where tenant_id = $1', [
          tenant.id,
        ])
      ).rows,
    ).toEqual([]);
  });

  it('chargeCall writes one call_charge at the answer time and charging twice charges once', async () => {
    const tenant = await rateTenant(owner);
    const cdr = call();
    await intake(tenant, cdr);
    const charge = () =>
      withSystem(app.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        return chargeCall(tx, { tenantId: tenant.id, callUuid: cdr.callUuid });
      });
    expect(await charge()).toEqual({
      charge: '0.1',
      occurredAt: cdr.answeredAt,
    });
    expect(await charge()).toEqual({
      charge: '0.1',
      occurredAt: cdr.answeredAt,
    });
    expect(
      (
        await owner.pool.query(
          `select amount::text, kind, occurred_at, idempotency_key, note from ledger_entries where tenant_id = $1`,
          [tenant.id],
        )
      ).rows,
    ).toEqual([
      {
        amount: '-0.1',
        kind: 'call_charge',
        occurred_at: cdr.answeredAt,
        idempotency_key: `call:${cdr.callUuid}`,
        note: `通话扣费 ${cdr.callUuid} 8613800138000`,
      },
    ]);
  });

  it('chargeCall writes nothing for an unanswered call or a missing call', async () => {
    const tenant = await rateTenant(owner);
    const cdr = call({ answeredAt: null });
    await intake(tenant, cdr);
    await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      expect(
        await chargeCall(tx, { tenantId: tenant.id, callUuid: cdr.callUuid }),
      ).toEqual({
        charge: '0',
        occurredAt: null,
      });
      await expect(
        chargeCall(tx, { tenantId: tenant.id, callUuid: randomUUID() }),
      ).rejects.toThrow(/不存在/);
    });
    expect(
      (
        await owner.pool.query(
          'select 1 from ledger_entries where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([]);
  });

  it('chargeCall refuses to write a charge into a month whose calls were deleted', async () => {
    const tenant = await rateTenant(owner);
    // 入库之后、扣费之前，月份被标为已删除（正常流程里删除会因未扣费的话单而被拒绝，这里直接置标志）。
    const callUuid = await chargedCall(owner, tenant.id, {
      answeredAt: '2026-07-15 10:00:00',
      ledger: false,
    });
    await deleteMonth(tenant.id, '2026-07-01');
    const error = await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      return chargeCall(tx, { tenantId: tenant.id, callUuid }).catch(
        (e: unknown) => e,
      );
    });
    expect(error).toBeInstanceOf(CdrMonthDeletedError);
    expect(error).toMatchObject({
      code: 'CDR_MONTH_DELETED',
      callUuid,
      month: '2026-07-01',
    });
    expect(
      (
        await owner.pool.query(
          'select 1 from ledger_entries where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([]);
  });
});
