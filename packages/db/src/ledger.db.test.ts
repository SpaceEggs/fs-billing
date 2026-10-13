import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { formatMoney, money } from '@fs-billing/rating';
import {
  connections,
  createTenant,
  pgError,
  tenantId,
} from '../test/support.js';
import { withAdmin, withTenant, type Tx } from './client.js';
import { appendLedgerEntry, callChargeKey } from './ledger.js';
import { loadRatingTenant } from './rates.js';

const { app, owner } = connections();

async function adminId() {
  const { rows } = await owner.pool.query<{ id: string }>(
    `SELECT id FROM admins WHERE email = 'wangmin@example.com'`,
  );
  return rows[0]!.id;
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
    const admin = await adminId();
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
        },
      );
    expect(mixed).toBeTypeOf('function');
  });

  it('数据库按类型检查符号与必填：正的通话扣费、无原因的调账被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId();
    const positiveCharge = await pgError(
      withAdmin(app.db, (tx) =>
        appendLedgerEntry(tx, tenant, {
          kind: 'call_charge',
          amount: money('CNY', '0.18'),
          note: '',
          idempotencyKey: 'call:positive',
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

describe('待收款 → 已收款', () => {
  it('结算是独立记录：原流水不变，状态由 receivables 视图给出，只能结算一次', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId();
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
    const admin = await adminId();
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
    const admin = await adminId();
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

  it('应用角色不能直接修改缓存余额', async () => {
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(sql`update tenant_balances set balance = 0`),
      ),
    );
    expect(error).toMatchObject({ code: '42501' });
  });
});
