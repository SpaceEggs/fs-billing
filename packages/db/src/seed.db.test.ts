import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { beijingTime, decimal, parseRateCsv } from '@fs-billing/rating';
import { SEEDED_AT } from '../test/global-setup.js';
import { connections } from '../test/support.js';
import { connect } from './client.js';
import { callChargeKey } from './ledger.js';
import { migrateDatabase } from './migrate.js';
import { ensureCdrPartitions } from './partitions.js';
import { currentMonthSeedMonth, planCurrentMonthCalls } from './seed-calls.js';
import { OCTOBER_RATES_CSV, seedDatabase } from './seed.js';

const { owner } = connections();

// 共享库在 global-setup 里用这个时刻播种，当月组固定是 2026-10。
if (currentMonthSeedMonth(SEEDED_AT) !== '2026-10-01')
  throw new Error('共享库的播种时刻应落在 2026-10，且不在 1 日第 1 秒');

const counts = async () =>
  (
    await owner.pool.query<Record<string, number>>(`select
      (select count(*)::int from cdrs) as cdrs,
      (select count(*)::int from call_uuids) as call_uuids,
      (select count(*)::int from ledger_entries) as ledger_entries,
      (select count(*)::int from tenant_balances where balance <> 0) as balances,
      (select count(*)::int from rate_versions) as rate_versions,
      (select count(*)::int from monthly_statements) as statements,
      (select count(*)::int from monthly_statement_countries) as countries,
      (select count(*)::int from monthly_statement_days) as days,
      (select count(*)::int from tenants) as tenants,
      (select count(*)::int from unassigned_cdrs) as unassigned`)
  ).rows[0];

describe('开发种子（阶段 7 决定 20）', () => {
  it('running the seed again adds no rows anywhere', async () => {
    const before = await counts();
    // 其他测试文件先于本文件写过行，所以不比绝对值；种子租户自己的话单数是确定的：
    // ABC001 的 8 月 9,642 + 9 月 12,804 通已接通加 1 条未接通示例话单，加 10 月的 20 通；GZT007 两条示例话单。
    const { rows } = await owner.pool.query(
      `select t.code, count(*)::int as cdrs from cdrs c join tenants t on t.id = c.tenant_id
       where t.code in ('ABC001', 'GZT007') group by t.code order by t.code`,
    );
    expect(rows).toEqual([
      { code: 'ABC001', cdrs: 22467 },
      { code: 'GZT007', cdrs: 2 },
    ]);
    await seedDatabase(owner.db, { now: SEEDED_AT });
    expect(await counts()).toEqual(before);
  });

  it('ABC001 opened on 2026-08-12 and its rate card applies from the opening', async () => {
    const { rows } = await owner.pool.query(
      `select to_char(t.created_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as created,
              to_char(min(v.effective_from) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as first_rate
       from tenants t join rate_versions v on v.tenant_id = t.id
       where t.code = 'ABC001' group by t.created_at`,
    );
    expect(rows).toEqual([
      { created: '2026-08-12 09:30:00', first_rate: '2026-08-12 09:30:00' },
    ]);
  });

  it('every seeded call has the production ledger key and no call is left for the Worker reconciliation to charge again', async () => {
    const { rows } = await owner.pool.query(`
      select
        (select count(*)::int from cdrs c where c.charge > 0 and not exists (
           select 1 from ledger_entries l where l.tenant_id = c.tenant_id and l.kind = 'call_charge'
             and l.idempotency_key = 'call:' || c.call_uuid::text)
           and c.tenant_id in (select id from tenants where code in ('ABC001', 'GZT007'))) as uncharged,
        (select count(*)::int from ledger_entries l join tenants t on t.id = l.tenant_id
          where t.code = 'ABC001' and l.kind = 'call_charge' and l.idempotency_key not like 'call:%') as seed_keys,
        (select count(*)::int from balance_discrepancies) as discrepancies`);
    expect(rows).toEqual([{ uncharged: 0, seed_keys: 0, discrepancies: 0 }]);
  });

  it('GZT007 sample calls are charged once with call:<uuid> keys: the balance is 86.27', async () => {
    const { rows } = await owner.pool.query(`
      select trim_scale(b.balance)::text as balance,
        (select count(*)::int from ledger_entries l where l.tenant_id = t.id and l.kind = 'call_charge') as charges,
        (select trim_scale(sum(l.amount))::text from ledger_entries l
          where l.tenant_id = t.id and l.kind = 'call_charge' and l.idempotency_key like 'call:a0000007-%') as sample_charges
      from tenants t join tenant_balances b on b.tenant_id = t.id where t.code = 'GZT007'`);
    expect(rows).toEqual([
      { balance: '86.27', charges: 3, sample_charges: '-0.23' },
    ]);
    const statement = await owner.pool.query(
      `select s.calls, trim_scale(s.call_charges)::text as call_charges, trim_scale(s.closing_balance)::text as closing,
              trim_scale(s.breakdown_gap)::text as gap
       from monthly_statements s join tenants t on t.id = s.tenant_id
       where t.code = 'GZT007' and s.month = '2026-09-01'`,
    );
    expect(statement.rows).toEqual([
      { calls: 2, call_charges: '1240.98', closing: '86.27', gap: '1240.75' },
    ]);
  });

  it('the seeded ledger of ABC001 follows the statement mockup: no gifts or reversals of the admin mockup remain', async () => {
    const { rows } = await owner.pool.query(`
      select to_char(l.occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month, l.kind,
        count(*)::int as n, trim_scale(sum(l.amount))::text as amount
      from ledger_entries l join tenants t on t.id = l.tenant_id
      where t.code = 'ABC001' and l.kind <> 'call_charge' group by 1, 2 order by 1, 2`);
    expect(rows).toEqual([
      { month: '2026-08', kind: 'gift', n: 1, amount: '50' },
      { month: '2026-08', kind: 'recharge', n: 1, amount: '3000' },
      { month: '2026-09', kind: 'adjustment', n: 1, amount: '-25.5' },
      { month: '2026-09', kind: 'credit_recharge', n: 1, amount: '500' },
      { month: '2026-09', kind: 'recharge', n: 1, amount: '800' },
      { month: '2026-10', kind: 'recharge', n: 1, amount: '3.51' },
    ]);
  });

  it('the current-month calls are all in the past, in the first second of the 1st, and offset exactly by one recharge', async () => {
    const { rows } = await owner.pool.query(
      `select count(*)::int as calls, sum(c.billed_minutes)::int as minutes,
              trim_scale(sum(c.charge))::text as charges,
              to_char(min(c.answered_at) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS.MS') as first_call,
              to_char(max(c.answered_at) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS.MS') as last_call,
              max(c.answered_at) < $2::timestamptz as in_the_past,
              (select to_char(l.occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
                 from ledger_entries l where l.tenant_id = c.tenant_id and l.kind = 'recharge'
                   and l.idempotency_key = 'seed:2026-10-01 00:03:00:recharge') as recharge_at
       from cdrs c join tenants t on t.id = c.tenant_id
       where t.code = 'ABC001' and c.answered_at >= $1::date::timestamp at time zone 'Asia/Shanghai'
       group by c.tenant_id`,
      ['2026-10-01', SEEDED_AT],
    );
    expect(rows).toEqual([
      {
        calls: 20,
        minutes: 81,
        charges: '3.51',
        first_call: '2026-10-01 00:00:00.020',
        last_call: '2026-10-01 00:00:00.400',
        in_the_past: true,
        recharge_at: '2026-10-01 00:00:00',
      },
    ]);
    const balance = await owner.pool.query(
      `select trim_scale(b.balance)::text as balance from tenant_balances b join tenants t on t.id = b.tenant_id where t.code = 'ABC001'`,
    );
    expect(balance.rows).toEqual([{ balance: '-35.2' }]);
  });
});

describe('seeding again in a later month', () => {
  /** 单独的库：不能往共享测试库里加后续月份的行。 */
  async function withScratchDatabase<T>(
    run: (scratch: ReturnType<typeof connect>) => Promise<T>,
  ): Promise<T> {
    const name = `fs_billing_seed_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const ownerUrl = (database: string) => {
      const url = new URL(inject('ownerUrl'));
      url.pathname = `/${database}`;
      return url.toString();
    };
    const appUrl = new URL(inject('appUrl'));
    appUrl.pathname = `/${name}`;
    const admin = new pg.Client({ connectionString: ownerUrl('postgres') });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      await migrateDatabase({
        DATABASE_URL: ownerUrl(name),
        APP_DATABASE_URL: appUrl.toString(),
      });
      const scratch = connect(ownerUrl(name));
      try {
        return await run(scratch);
      } finally {
        await scratch.pool.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    }
  }

  const abc001 = (pool: pg.Pool) =>
    pool.query<{
      balance: string;
      calls: number;
      recharges: number;
      cdrs: number;
    }>(`
      select trim_scale(b.balance)::text as balance,
        (select count(*)::int from ledger_entries l where l.tenant_id = t.id and l.kind = 'call_charge'
           and l.occurred_at >= '2026-09-30 16:00+00') as calls,
        (select count(*)::int from ledger_entries l where l.tenant_id = t.id and l.kind = 'recharge'
           and l.occurred_at >= '2026-09-30 16:00+00') as recharges,
        (select count(*)::int from cdrs c where c.tenant_id = t.id) as cdrs
      from tenants t join tenant_balances b on b.tenant_id = t.id where t.code = 'ABC001'`);

  it('postpones the month during its first second and keeps the balance at -35.20', async () => {
    await withScratchDatabase(async ({ db, pool }) => {
      const seedAt = async (moment: string) =>
        seedDatabase(db, { now: new Date(moment) });

      // 第 1 秒内不写当月组：20 通还没全部接通。
      await seedAt('2026-10-01T00:00:00.500+08:00');
      expect((await abc001(pool)).rows[0]).toEqual({
        balance: '-35.2',
        calls: 0,
        recharges: 0,
        cdrs: 22447,
      });
      await seedAt('2026-10-01T00:00:01+08:00');
      const october = (await abc001(pool)).rows[0]!;
      expect(october).toEqual({
        balance: '-35.2',
        calls: 20,
        recharges: 1,
        cdrs: 22467,
      });
      // 同一个月重复播种不增行。
      await seedAt('2026-10-30T09:00:00+08:00');
      expect((await abc001(pool)).rows[0]).toEqual(october);

      // 下个月的第 1 秒同样推迟；过了这一秒才加另一组，上个月的行还在。
      await seedAt('2026-11-01T00:00:00+08:00');
      expect((await abc001(pool)).rows[0]).toEqual(october);
      await seedAt('2026-11-01T00:00:01+08:00');
      expect((await abc001(pool)).rows[0]).toEqual({
        balance: '-35.2',
        calls: 40,
        recharges: 2,
        cdrs: 22487,
      });
      await seedAt('2026-11-16T12:00:00+08:00');
      expect((await abc001(pool)).rows[0]!.cdrs).toBe(22487);

      // 12 月 1 日 00:30 同样播种当月这一组，不回头补更早的空月。
      await seedAt('2026-12-01T00:30:00+08:00');
      const december = (await abc001(pool)).rows[0]!;
      expect(december).toEqual({
        balance: '-35.2',
        calls: 60,
        recharges: 3,
        cdrs: 22507,
      });
      await seedAt('2026-12-01T00:30:00+08:00');
      expect((await abc001(pool)).rows[0]).toEqual(december);

      // 每个月的账本都自己抵平：各月预存等于各月扣费。
      const perMonth = await pool.query(`
        select to_char(l.occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month,
          trim_scale(sum(l.amount) filter (where l.kind = 'recharge'))::text as recharge,
          trim_scale(sum(l.amount) filter (where l.kind = 'call_charge'))::text as charges
        from ledger_entries l join tenants t on t.id = l.tenant_id
        where t.code = 'ABC001' and l.occurred_at >= '2026-09-30 16:00+00' group by 1 order by 1`);
      expect(perMonth.rows).toEqual([
        { month: '2026-10', recharge: '3.51', charges: '-3.51' },
        { month: '2026-11', recharge: '3.51', charges: '-3.51' },
        { month: '2026-12', recharge: '3.51', charges: '-3.51' },
      ]);

      // 8、9 月的账单数字不受影响。
      const statements = await pool.query(`
        select to_char(s.month, 'YYYY-MM') as month, s.calls, trim_scale(s.closing_balance)::text as closing
        from monthly_statements s join tenants t on t.id = s.tenant_id where t.code = 'ABC001' order by 1`);
      expect(statements.rows).toEqual([
        { month: '2026-08', calls: 9642, closing: '1176.6' },
        { month: '2026-09', calls: 12804, closing: '-35.2' },
      ]);
    });
  }, 120_000);

  it('does not seed any current-month calls while the clock is still in the mockup months', async () => {
    await withScratchDatabase(async ({ db, pool }) => {
      await seedDatabase(db, { now: new Date('2026-09-20T12:00:00+08:00') });
      const result = (await abc001(pool)).rows[0]!;
      expect(result).toMatchObject({
        balance: '-35.2',
        calls: 0,
        recharges: 0,
      });
    });
  }, 120_000);

  it('reseeds a month the old seed already wrote without a second recharge or rewritten call times', async () => {
    await withScratchDatabase(async ({ db, pool }) => {
      await seedDatabase(db, { now: new Date('2026-09-20T12:00:00+08:00') });
      expect((await abc001(pool)).rows[0]).toMatchObject({
        balance: '-35.2',
        calls: 0,
        recharges: 0,
        cdrs: 22447,
      });

      const rates = parseRateCsv(OCTOBER_RATES_CSV, 'CNY');
      if (!rates.ok) throw new Error('测试 10 月费率表无效');
      const plan = planCurrentMonthCalls({
        month: '2026-11-01',
        tenantCode: 'ABC001',
        entries: rates.entries,
        caller: '075586001234',
      });
      // origin/main 旧种子 UUID：fs-billing:seed:ABC001:cdr:2026-11-01:0..19，不跟当前规划函数走。
      const oldCallUuids = [
        'a3c3231e-bd95-519e-a2fd-774652b7ed43',
        '7657f3b4-6182-5762-acda-92fe1a4ef31c',
        '9b100156-93ba-53a7-a006-0dd4eb6924e9',
        '0cb3f419-7486-5b5f-a727-d96dbfcece46',
        '63ca2277-f3c2-572f-87f6-d5cc9d577809',
        '7227b704-8165-58db-8d2d-60e8c312ed28',
        '3a9a2892-b135-5b5a-9c81-c47618b491ea',
        'a2d0a806-18e3-5070-aa49-0619511fccea',
        '612857fc-664b-5867-a3fb-45d1a1c41cc3',
        '2254aad7-c438-522b-94c3-321162aef1db',
        '8cc28f2c-6c90-59bb-85fc-2e8442d9c605',
        '66655014-ca09-58b3-a871-63e2b1c9646d',
        'bd2ad084-e26d-5f7f-a304-65d91095bbe6',
        '93b91c6e-29a8-5e7f-8ecd-885dd13abe3e',
        '18dd21ba-2a6f-57d0-b0be-060a5ba5cb0a',
        'b924dbce-ae1f-5672-8e03-8fc7a6d8fc25',
        'd64407d8-b97a-56f7-97b5-275876300fae',
        '832edcb8-93a9-5215-b83c-5b3ea0099ce8',
        'e4ea6a00-e6fd-56c7-8a9e-e08b379d0791',
        '203e15ba-b4ba-509e-a694-6b5129c311f3',
      ] as const;
      // 旧种子的接通时刻。UUID 写成字面量，所以再播种会跳过这些话单，而不是改写时间。
      const opening = beijingTime('2026-11-01 00:05:20').getTime();
      const tenant = (
        await pool.query<{ id: string }>(
          `select id from tenants where code = 'ABC001'`,
        )
      ).rows[0]!;
      const admin = (await pool.query<{ id: string }>(`select id from admins`))
        .rows[0]!;
      await ensureCdrPartitions(db, {
        moment: beijingTime('2026-11-01 00:00:00'),
        monthsAhead: 0,
      });
      const client = await pool.connect();
      try {
        await client.query('begin');
        await client.query(`select set_config('app.scope', 'system', true)`);
        await client.query('select lock_tenants(array[$1]::uuid[])', [
          tenant.id,
        ]);
        for (const [k, call] of plan.calls.entries()) {
          const callUuid = oldCallUuids[k];
          if (callUuid === undefined)
            throw new Error(`旧版 UUID 夹具缺少第 ${k} 通`);
          const answered = new Date(opening + k * 1000);
          const ended = new Date(
            answered.getTime() + call.durationSeconds * 1000,
          );
          await client.query(
            `insert into cdrs (
               tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
               billing_number, duration_seconds, billed_minutes, matched_prefix, country, iso,
               description, rate, charge, hangup_cause
             ) values (
               $1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
             )`,
            [
              tenant.id,
              callUuid,
              answered,
              ended,
              call.caller,
              call.callee,
              call.billingNumber,
              call.durationSeconds,
              call.billedMinutes,
              call.matchedPrefix,
              call.country,
              call.iso || null,
              call.description || null,
              call.perMinute,
              call.charge,
              call.hangupCause,
            ],
          );
          await client.query(
            `insert into ledger_entries (
               tenant_id, kind, amount, note, idempotency_key, occurred_at, created_at
             ) values ($1, 'call_charge', $2, $3, $4, $5, $6)`,
            [
              tenant.id,
              decimal(call.charge).neg().toFixed(),
              `通话扣费 ${callUuid} ${call.billingNumber}`,
              callChargeKey(callUuid),
              answered,
              new Date(ended.getTime() + 3000),
            ],
          );
        }
        const rechargeAt = beijingTime('2026-11-01 00:03:00');
        await client.query(
          `insert into ledger_entries (
             tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at
           ) values ($1, 'recharge', $2, '银行转账预存', $3, 'seed:2026-11-01 00:03:00:recharge', $4, $4)`,
          [tenant.id, '3.51', admin.id, rechargeAt],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      const before = (await abc001(pool)).rows[0]!;
      expect(before).toEqual({
        balance: '-35.2',
        calls: 20,
        recharges: 1,
        cdrs: 22467,
      });
      await seedDatabase(db, { now: new Date('2026-11-15T12:00:00+08:00') });
      expect((await abc001(pool)).rows[0]).toEqual(before);
      const kept = await pool.query<{
        first_call: string;
        recharge_at: string;
        old_keys: number;
        shifted_keys: number;
      }>(
        `select
           to_char(min(c.answered_at) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as first_call,
           (select to_char(l.occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
              from ledger_entries l
              where l.tenant_id = t.id and l.idempotency_key = 'seed:2026-11-01 00:03:00:recharge') as recharge_at,
           (select count(*)::int from ledger_entries l
              where l.tenant_id = t.id and l.idempotency_key = 'seed:2026-11-01 00:03:00:recharge') as old_keys,
           (select count(*)::int from ledger_entries l
              where l.tenant_id = t.id and l.idempotency_key = 'seed:2026-11-01 00:00:00:recharge') as shifted_keys
         from cdrs c join tenants t on t.id = c.tenant_id
         where t.code = 'ABC001' and c.answered_at >= '2026-11-01 00:00:00+08'
         group by t.id`,
      );
      expect(kept.rows).toEqual([
        {
          first_call: '2026-11-01 00:05:20',
          recharge_at: '2026-11-01 00:03:00',
          old_keys: 1,
          shifted_keys: 0,
        },
      ]);
    });
  }, 120_000);
});
