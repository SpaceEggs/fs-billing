import { describe, expect, it } from 'vitest';
import { scratchDatabase } from '../test/scratch.js';
import { seedDatabase } from './seed.js';

const scratch = scratchDatabase({ seed: true });

const ledgerOf = async (code: string) =>
  (
    await scratch.owner.pool.query<{
      n: number;
      total: string;
      credits: number;
    }>(
      `select count(*)::int as n, sum(l.amount)::text as total,
              count(*) filter (where l.kind = 'credit_recharge')::int as credits
       from ledger_entries l join tenants t on t.id = l.tenant_id where t.code = $1`,
      [code],
    )
  ).rows[0]!;

describe('re-seeding a database seeded before PR 8 (阶段 9 PR 8)', () => {
  it('does not add the new credit entry on top of the old, larger prepayment', async () => {
    // 复现旧库：流水只能新增，测试用 owner 暂时关掉用户触发器，把 BJH003 改回旧种子的形状——
    // 预存 = 余额 + 本月消费（4391.60），没有赊账。
    const fresh = await ledgerOf('BJH003');
    expect(fresh.credits).toBe(1);
    const client = await scratch.owner.pool.connect();
    try {
      await client.query('alter table ledger_entries disable trigger user');
      await client.query(
        `delete from ledger_entries where kind = 'credit_recharge'
           and idempotency_key like 'seed:%'
           and tenant_id = (select id from tenants where code = 'BJH003')`,
      );
      await client.query(
        `update ledger_entries set amount = 4391.60
         where idempotency_key = 'seed:2026-09-01 10:00:00:recharge'
           and tenant_id = (select id from tenants where code = 'BJH003')`,
      );
    } finally {
      await client.query('alter table ledger_entries enable trigger user');
      client.release();
    }
    const legacy = await ledgerOf('BJH003');
    expect(legacy.credits).toBe(0);

    await seedDatabase(scratch.owner.db);

    // 旧库上重新播种什么也不加：余额与账单核对不会因此漂移。
    expect(await ledgerOf('BJH003')).toEqual(legacy);
    // 没有旧库痕迹的租户照常幂等。
    const other = await ledgerOf('SHC005');
    await seedDatabase(scratch.owner.db);
    expect(await ledgerOf('SHC005')).toEqual(other);
  });
});
