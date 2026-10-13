import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { beijingTime, formatMoney, money } from '@fs-billing/rating';
import {
  adminId,
  connections,
  createTenant,
  pgError,
  tenantId,
} from '../test/support.js';
import { withAdmin, withTenant, type Tx } from './client.js';
import { appendLedgerEntry, callChargeKey } from './ledger.js';
import { loadRatingTenant } from './rates.js';

const { app, owner } = connections();

async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await owner.pool.query<{ blocked: boolean }>(
      'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
      [pid],
    );
    if (rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`连接 ${pid} 没有进入锁等待`);
}

describe('ABC001 种子余额', () => {
  it('以 ABC001 身份对流水求和（SQL 中没有租户条件）得到 −35.20', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const result = await withTenant(app.db, abc001, async (tx) => ({
      ledger: (
        await tx.execute(
          sql`select sum(amount)::text as total, count(*)::int as entries from ledger_entries`,
        )
      ).rows,
      cached: (await tx.execute(sql`select balance::text from tenant_balances`))
        .rows,
      display: formatMoney((await loadRatingTenant(tx, 'ABC001'))!.balance),
    }));
    expect(result).toEqual({
      ledger: [{ total: '-35.20', entries: 33 }],
      cached: [{ balance: '-35.20' }],
      display: '-35.20',
    });
  });

  it('缓存余额与流水合计没有差异', async () => {
    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute(sql`select * from balance_discrepancies`),
    );
    expect(rows).toEqual([]);
  });
});

describe('流水只能新增', () => {
  it('应用角色执行 UPDATE / DELETE / TRUNCATE 被拒绝（无权限）', async () => {
    for (const statement of [
      sql`update ledger_entries set amount = 0`,
      sql`delete from ledger_entries`,
      sql`truncate ledger_entries`,
    ]) {
      const error = await pgError(
        withAdmin(app.db, (tx) => tx.execute(statement)),
      );
      expect(error).toMatchObject({
        code: '42501',
        message: 'permission denied for table ledger_entries',
      });
    }
  });

  it('owner（超级用户）执行 UPDATE / DELETE / TRUNCATE 也被触发器拒绝', async () => {
    const messages = [];
    for (const statement of [
      'UPDATE ledger_entries SET amount = 0',
      'DELETE FROM ledger_entries',
      'TRUNCATE ledger_entries CASCADE',
    ]) {
      messages.push((await pgError(owner.pool.query(statement))).message);
    }
    expect(messages).toEqual([
      'ledger_entries 只能新增，禁止 UPDATE',
      'ledger_entries 只能新增，禁止 DELETE',
      'ledger_entries 只能新增，禁止 TRUNCATE',
    ]);
    const { rows } = await owner.pool.query(
      `SELECT count(*)::int AS seeded FROM ledger_entries WHERE idempotency_key LIKE 'seed:%'`,
    );
    expect(rows).toEqual([{ seeded: 50 }]);
  });
});

describe('appendLedgerEntry', () => {
  it('同一幂等键重试只记一次账，余额只变一次', async () => {
    const tenant = await createTenant(app, 'CNY');
    const callUuid = '0b6ac2f4-9b8e-4c55-a7a5-3c1f0b6a1e11';
    const charge = {
      kind: 'call_charge',
      amount: money('CNY', '-0.18'),
      note: '447700900123 通话 3分50秒',
      idempotencyKey: callChargeKey(callUuid),
      occurredAt: beijingTime('2026-10-12 10:00:12'),
    } as const;
    const first = await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, charge),
    );
    const retry = await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, charge),
    );
    const state = await withTenant(app.db, tenant.id, async (tx) => ({
      entries: (
        await tx.execute(
          sql`select idempotency_key, amount::text from ledger_entries`,
        )
      ).rows,
      balance: (
        await tx.execute(sql`select balance::text from tenant_balances`)
      ).rows,
    }));
    expect(retry.id).toBe(first.id);
    expect(state).toEqual({
      entries: [{ idempotency_key: `call:${callUuid}`, amount: '-0.18' }],
      balance: [{ balance: '-0.18' }],
    });
  });

  it('同一幂等键但金额不同时报错', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const entry = (value: string) => ({
      kind: 'recharge' as const,
      amount: money('CNY', value),
      note: '银行转账',
      adminId: admin,
      idempotencyKey: 'recharge-20261012-001',
    });
    await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, entry('100.00')),
    );
    await expect(
      withAdmin(app.db, (tx) => appendLedgerEntry(tx, tenant, entry('50.00'))),
    ).rejects.toThrow('幂等键 recharge-20261012-001 已用于另一笔流水');
  });

  it('CNY 金额记入 USD 租户在类型检查阶段报错', () => {
    const mixed = (tx: Tx) =>
      appendLedgerEntry(
        tx,
        { id: '', currency: 'USD' },
        {
          kind: 'call_charge',
          // @ts-expect-error Money<"CNY"> 不能用于 USD 租户
          amount: money('CNY', '-1'),
          note: '',
          idempotencyKey: 'k',
          occurredAt: new Date(0),
        },
      );
    expect(mixed).toBeTypeOf('function');
  });

  it('数据库按类型检查符号与必填：正的通话扣费、无原因的调账被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const positiveCharge = await pgError(
      withAdmin(app.db, (tx) =>
        appendLedgerEntry(tx, tenant, {
          kind: 'call_charge',
          amount: money('CNY', '0.18'),
          note: '',
          idempotencyKey: 'call:positive',
          occurredAt: beijingTime('2026-10-12 10:00:12'),
        }),
      ),
    );
    const silentAdjustment = await pgError(
      withAdmin(app.db, (tx) =>
        appendLedgerEntry(tx, tenant, {
          kind: 'adjustment',
          amount: money('CNY', '-5'),
          note: ' ',
          adminId: admin,
          idempotencyKey: 'adjust:no-reason',
        }),
      ),
    );
    expect([positiveCharge, silentAdjustment]).toMatchObject([
      { code: '23514', constraint: 'ledger_entries_kind_shape' },
      { code: '23514', constraint: 'ledger_entries_kind_shape' },
    ]);
  });
});

describe('流水按发生时间归属月份', () => {
  it('9-30 23:59（北京时间）接通、10-01 才写入的扣费，按 occurred_at 归属 9 月', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, {
        kind: 'call_charge',
        amount: money('CNY', '-0.05'),
        note: '8613800138000 通话 1分0秒',
        idempotencyKey: callChargeKey('5d0b7c1e-2f4a-4b8e-9c61-0e3a9f1d2c30'),
        occurredAt: beijingTime('2026-09-30 23:59:00'),
        createdAt: beijingTime('2026-10-01 00:00:30'),
      }),
    );
    const { rows } = await withTenant(app.db, tenant.id, (tx) =>
      tx.execute(sql`
        select to_char(occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month,
               to_char(created_at at time zone 'Asia/Shanghai', 'YYYY-MM') as written,
               sum(amount)::text as charges
        from ledger_entries where kind = 'call_charge' group by 1, 2`),
    );
    expect(rows).toEqual([
      { month: '2026-09', written: '2026-10', charges: '-0.05' },
    ]);
  });

  it('种子中 ABC001 的通话扣费全部归属 9 月，合计 −2486.30（设计稿本月消费）', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const { rows } = await withTenant(app.db, abc001, (tx) =>
      tx.execute(sql`
        select to_char(occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month,
               sum(amount)::text as charges, count(*)::int as entries
        from ledger_entries where kind = 'call_charge' group by 1`),
    );
    expect(rows).toEqual([
      { month: '2026-09', charges: '-2486.30', entries: 28 },
    ]);
  });

  it('人工操作的发生时间只能是写入时间', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const backdated = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(sql`insert into ledger_entries
          (tenant_id, kind, amount, created_by, idempotency_key, occurred_at)
          values (${tenant.id}, 'recharge', 100, ${admin}, 'recharge-backdated',
                  '2026-09-30T12:00:00+08:00')`),
      ),
    );
    expect(backdated).toMatchObject({
      code: '23514',
      constraint: 'ledger_entries_kind_shape',
    });
  });
});

describe('待收款 → 已收款', () => {
  it('结算是独立记录：原流水不变，状态由 receivables 视图给出，只能结算一次', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const credit = await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, {
        kind: 'credit_recharge',
        amount: money('CNY', '500.00'),
        note: '月结，10月5日前付款',
        adminId: admin,
        idempotencyKey: 'credit-1',
      }),
    );
    const status = () =>
      withTenant(
        app.db,
        tenant.id,
        async (tx) =>
          (
            await tx.execute(
              sql`select status, amount::text, received_on::text from receivables`,
            )
          ).rows,
      );
    const settle = (entryId: string) =>
      withAdmin(app.db, (tx) =>
        tx.execute(sql`insert into receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by)
                       values (${tenant.id}, ${entryId}, '2026-10-05', ${admin})`),
      );

    expect(await status()).toEqual([
      { status: 'pending', amount: '500', received_on: null },
    ]);
    await settle(credit.id);
    expect(await status()).toEqual([
      { status: 'received', amount: '500', received_on: '2026-10-05' },
    ]);
    expect(await pgError(settle(credit.id))).toMatchObject({
      code: '23505',
      constraint: 'receivable_settlements_ledger_entry_id_key',
    });

    const { rows } = await owner.pool.query(
      'SELECT kind, amount::text FROM ledger_entries WHERE id = $1',
      [credit.id],
    );
    expect(rows).toEqual([{ kind: 'credit_recharge', amount: '500' }]);
  });

  it('不能结算非赊账充值的流水', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const recharge = await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, {
        kind: 'recharge',
        amount: money('CNY', '100'),
        note: '银行转账',
        adminId: admin,
        idempotencyKey: 'recharge-1',
      }),
    );
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(sql`insert into receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by)
                       values (${tenant.id}, ${recharge.id}, '2026-10-05', ${admin})`),
      ),
    );
    expect(error.code).toBe('23503');
  });
});

describe('缓存余额可重算核对', () => {
  it('缓存被改坏后，balance_discrepancies 列出该租户，rebuild_tenant_balances 修复', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, {
        kind: 'gift',
        amount: money('CNY', '20.00'),
        note: '线路故障补偿',
        adminId: admin,
        idempotencyKey: 'gift-1',
      }),
    );
    await owner.pool.query(
      'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = $1',
      [tenant.id],
    );
    const discrepancies = () =>
      owner.pool.query(
        'SELECT code, cached_balance::text, ledger_total::text FROM balance_discrepancies',
      );

    expect((await discrepancies()).rows).toEqual([
      { code: tenant.code, cached_balance: '999', ledger_total: '20' },
    ]);
    expect(
      (await owner.pool.query('SELECT rebuild_tenant_balances() AS fixed'))
        .rows,
    ).toEqual([{ fixed: 1 }]);
    expect((await discrepancies()).rows).toEqual([]);
  });

  it('扣费已写入未提交时开始重算：重算等扣费提交，结束后缓存 = 流水合计', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, {
        kind: 'gift',
        amount: money('CNY', '20.00'),
        note: '线路故障补偿',
        adminId: admin,
        idempotencyKey: 'gift-1',
      }),
    );
    await owner.pool.query(
      'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = $1',
      [tenant.id],
    );

    const charging = await app.pool.connect();
    const rebuilding = await owner.pool.connect();
    try {
      await charging.query('BEGIN');
      await charging.query(`SELECT set_config('app.scope', 'system', true)`);
      await charging.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -5, 'call:interleaved')`,
        [tenant.id],
      );
      const { rows } = await rebuilding.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const rebuilt = rebuilding.query('SELECT rebuild_tenant_balances()');
      await waitUntilBlocked(rows[0]!.pid);
      await charging.query('COMMIT');
      await rebuilt;
    } finally {
      await charging.query('ROLLBACK');
      charging.release();
      rebuilding.release();
    }

    const { rows } = await owner.pool.query(
      `SELECT balance::text AS cached,
              (SELECT sum(amount)::text FROM ledger_entries WHERE tenant_id = $1) AS ledger_total
       FROM tenant_balances WHERE tenant_id = $1`,
      [tenant.id],
    );
    expect(rows).toEqual([{ cached: '15', ledger_total: '15' }]);
  });

  it('应用角色不能直接修改缓存余额', async () => {
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(sql`update tenant_balances set balance = 0`),
      ),
    );
    expect(error).toMatchObject({ code: '42501' });
  });
});
