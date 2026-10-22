import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { connections } from '../test/support.js';
import { connect } from './client.js';
import { migrateDatabase } from './migrate.js';
import { currentMonthSeedMonth } from './seed-calls.js';
import { seedDatabase } from './seed.js';

const { owner } = connections();

/** 播种月（数据库时钟所在的月）；时钟太靠近 1 日凌晨时没有。 */
const currentMonth = currentMonthSeedMonth(new Date());

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
    // ABC001 的 8 月 9,642 + 9 月 12,804 通已接通加 1 条未接通示例话单，加播种月的 20 通；GZT007 两条示例话单。
    const { rows } = await owner.pool.query(
      `select t.code, count(*)::int as cdrs from cdrs c join tenants t on t.id = c.tenant_id
       where t.code in ('ABC001', 'GZT007') group by t.code order by t.code`,
    );
    expect(rows).toEqual([
      { code: 'ABC001', cdrs: 22447 + (currentMonth ? 20 : 0) },
      { code: 'GZT007', cdrs: 2 },
    ]);
    await seedDatabase(owner.db);
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
      ...(currentMonth
        ? [
            {
              month: currentMonth.slice(0, 7),
              kind: 'recharge',
              n: 1,
              amount: '3.51',
            },
          ]
        : []),
    ]);
  });

  it('the current-month calls are all in the past, in the early hours of the 1st, and offset exactly by one recharge', async () => {
    if (!currentMonth) return;
    const { rows } = await owner.pool.query(
      `select count(*)::int as calls, sum(c.billed_minutes)::int as minutes,
              trim_scale(sum(c.charge))::text as charges,
              to_char(min(c.answered_at) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as first_call,
              to_char(max(c.answered_at) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as last_call,
              max(c.answered_at) < now() as in_the_past,
              (select to_char(l.occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS')
                 from ledger_entries l where l.tenant_id = c.tenant_id and l.kind = 'recharge'
                   and l.occurred_at >= $1::date::timestamp at time zone 'Asia/Shanghai') as recharge_at
       from cdrs c join tenants t on t.id = c.tenant_id
       where t.code = 'ABC001' and c.answered_at >= $1::date::timestamp at time zone 'Asia/Shanghai'
       group by c.tenant_id`,
      [currentMonth],
    );
    expect(rows).toEqual([
      {
        calls: 20,
        minutes: 81,
        charges: '3.51',
        first_call: `${currentMonth} 00:05:20`,
        last_call: `${currentMonth} 01:59:30`,
        in_the_past: true,
        recharge_at: `${currentMonth} 00:03:00`,
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

  it('adds one set per month, keeps the balance at -35.20 and skips the early hours of the 1st', async () => {
    await withScratchDatabase(async ({ db, pool }) => {
      const seedAt = async (moment: string) =>
        seedDatabase(db, { now: new Date(moment) });

      await seedAt('2026-10-22T15:00:00+08:00');
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

      // 下个月再播种：另一组 20 通与另一笔预存，上个月的行还在，余额仍是 −35.20。
      await seedAt('2026-11-15T12:00:00+08:00');
      expect((await abc001(pool)).rows[0]).toEqual({
        balance: '-35.2',
        calls: 40,
        recharges: 2,
        cdrs: 22487,
      });
      await seedAt('2026-11-16T12:00:00+08:00');
      expect((await abc001(pool)).rows[0]!.cdrs).toBe(22487);

      // 12 月 1 日 00:30：凌晨的通话还没发生，不播种（也不回头补 11 月之外的月份）。
      await seedAt('2026-12-01T00:30:00+08:00');
      expect((await abc001(pool)).rows[0]!.cdrs).toBe(22487);

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
});
