import { describe, expect, it } from 'vitest';
import { connections } from '../test/support.js';
import { seedDatabase } from './seed.js';

const { owner } = connections();

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
    // ABC001 的 8 月 9,642 + 9 月 12,804 通已接通加 1 条未接通示例话单，GZT007 两条示例话单。
    const { rows } = await owner.pool.query(
      `select t.code, count(*)::int as cdrs from cdrs c join tenants t on t.id = c.tenant_id
       where t.code in ('ABC001', 'GZT007') group by t.code order by t.code`,
    );
    expect(rows).toEqual([
      { code: 'ABC001', cdrs: 22447 },
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
           and c.tenant_id = (select id from tenants where code = 'ABC001')) as abc001_uncharged,
        (select count(*)::int from ledger_entries l join tenants t on t.id = l.tenant_id
          where t.code = 'ABC001' and l.kind = 'call_charge' and l.idempotency_key not like 'call:%') as seed_keys,
        (select count(*)::int from balance_discrepancies) as discrepancies`);
    expect(rows).toEqual([
      { abc001_uncharged: 0, seed_keys: 0, discrepancies: 0 },
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
    ]);
  });
});
