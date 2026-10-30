import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { beijingTime, formatMoney, money } from '@fs-billing/rating';
import {
  adminId,
  adminTransaction,
  backendPid,
  connections,
  createTenant,
  deferred,
  pgError,
  tenantId,
  waitForTenantLock,
} from '../test/support.js';
import { lockTenants, withAdmin, withTenant, type Tx } from './client.js';
import {
  appendLedgerEntries,
  appendLedgerEntry,
  callChargeKey,
} from './ledger.js';
import { createRateVersion, loadRatingTenant } from './rates.js';
import { currentMonthSeedMonth } from './seed-calls.js';

const { app, owner } = connections();

/** 播种月（数据库时钟所在的月）的 20 通话单加 1 笔等额预存；时钟太靠近 1 日凌晨时不播种。 */
const currentMonth = currentMonthSeedMonth(new Date());

/** 等到 `pid` 进入锁等待。给出 `blockerPid` 时，必须是这个后端拿着锁。 */
async function waitUntilBlocked(pid: number, blockerPid?: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await owner.pool.query<{ blocked: boolean }>(
      blockerPid === undefined
        ? 'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked'
        : 'SELECT $2::integer = ANY (pg_blocking_pids($1)) AS blocked',
      blockerPid === undefined ? [pid] : [pid, blockerPid],
    );
    if (rows[0]!.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    blockerPid === undefined
      ? `连接 ${pid} 没有进入锁等待`
      : `连接 ${pid} 没有被连接 ${blockerPid} 堵住`,
  );
}

describe('ABC001 种子余额', () => {
  it('以 ABC001 身份对流水求和（SQL 中没有租户条件）得到 −35.20', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const result = await withTenant(app.db, abc001, async (tx) => ({
      ledger: (
        await tx.execute(
          sql`select trim_scale(sum(amount))::text as total, count(*)::int as entries from ledger_entries`,
        )
      ).rows,
      cached: (
        await tx.execute(
          sql`select trim_scale(balance)::text as balance from tenant_balances`,
        )
      ).rows,
      display: formatMoney((await loadRatingTenant(tx, 'ABC001'))!.balance),
    }));
    expect(result).toEqual({
      // 5 笔人工流水 + 8 月 9,642 笔与 9 月 12,804 笔逐通扣费（阶段 7 决定 20），
      // 加播种月 20 笔扣费与 1 笔等额预存（合计抵平，余额不变）。
      ledger: [{ total: '-35.2', entries: currentMonth ? 22472 : 22451 }],
      cached: [{ balance: '-35.2' }],
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
    // 22 条：ABC001 的人工流水与汇总流水；PR 8 起另有 4 条赊账（BJH003、SHC005、XYZ002、NYC021 的待收款）。
    expect(rows).toEqual([{ seeded: currentMonth ? 27 : 26 }]);
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
    await owner.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.scope', 'system', true)`);
      await lockTenants(tx, [tenant.id]);
      await tx.execute(sql`
        insert into ledger_entries (tenant_id, kind, amount, note, idempotency_key, occurred_at, created_at)
        values (${tenant.id}, 'call_charge', -0.05, '8613800138000 通话 1分0秒',
                ${callChargeKey('5d0b7c1e-2f4a-4b8e-9c61-0e3a9f1d2c30')},
                '2026-09-30 23:59:00+08', '2026-10-01 00:00:30+08')`);
    });
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

  it('种子中 ABC001 的通话扣费按接通时间归属 8、9 月（合计即月账单设计稿的通话扣费）和播种月', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const { rows } = await withTenant(app.db, abc001, (tx) =>
      tx.execute(sql`
        select to_char(occurred_at at time zone 'Asia/Shanghai', 'YYYY-MM') as month,
               trim_scale(sum(amount))::text as charges, count(*)::int as entries
        from ledger_entries where kind = 'call_charge' group by 1 order by 1`),
    );
    expect(rows).toEqual([
      { month: '2026-08', charges: '-1873.4', entries: 9642 },
      { month: '2026-09', charges: '-2486.3', entries: 12804 },
      ...(currentMonth
        ? [{ month: currentMonth.slice(0, 7), charges: '-3.51', entries: 20 }]
        : []),
    ]);
  });

  it('种子的逐通扣费用生产的幂等键 call:<UUID>，每条有对应话单，Worker 的补扣对账找不到缺失', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const { rows } = await withTenant(app.db, abc001, (tx) =>
      tx.execute(sql`
        select
          count(*) filter (where l.idempotency_key not like 'call:%')::int as other_keys,
          (select count(*)::int from cdrs c
            where c.charge > 0 and not exists (
              select 1 from ledger_entries x where x.tenant_id = c.tenant_id and x.kind = 'call_charge'
                and x.idempotency_key = 'call:' || c.call_uuid::text)) as uncharged_cdrs,
          count(*) filter (where l.occurred_at >= l.created_at)::int as not_after_answer
        from ledger_entries l where l.kind = 'call_charge'`),
    );
    expect(rows).toEqual([
      { other_keys: 0, uncharged_cdrs: 0, not_after_answer: 0 },
    ]);
  });

  it('人工操作的发生时间只能是写入时间', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const backdated = await pgError(
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        await tx.execute(sql`insert into ledger_entries
          (tenant_id, kind, amount, created_by, idempotency_key, occurred_at)
          values (${tenant.id}, 'recharge', 100, ${admin}, 'recharge-backdated',
                  '2026-09-30T12:00:00+08:00')`);
      }),
    );
    expect(backdated).toMatchObject({
      code: '23514',
      constraint: 'ledger_entries_kind_shape',
    });
  });

  it('应用角色不能回填 created_at，人工调账的两列都是数据库 now()', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const written = await withAdmin(app.db, async (tx) => {
      const entry = await appendLedgerEntry(tx, tenant, {
        kind: 'adjustment',
        amount: money('CNY', '-1.00'),
        note: '冲正',
        adminId: admin,
        idempotencyKey: 'adjust:now',
      });
      const { rows } = await tx.execute<{ same: boolean; at_db_now: boolean }>(
        sql`select occurred_at = created_at as same,
                   created_at = transaction_timestamp() as at_db_now
            from ledger_entries where id = ${entry.id}`,
      );
      return rows[0];
    });
    const backfill = await pgError(
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        await tx.execute(sql`insert into ledger_entries
          (tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
          values (${tenant.id}, 'adjustment', -5.00, '倒填', ${admin}, 'adjust:backfill',
                  '2026-09-01 00:00:00+08', '2026-09-01 00:00:00+08')`);
      }),
    );
    expect(written).toEqual({ same: true, at_db_now: true });
    expect(backfill).toMatchObject({
      code: '42501',
      message: 'created_at 由数据库生成',
    });
  });
});

describe('待收款 → 已收款', () => {
  it('结算是独立记录：原流水不变，已有未撤销确认时拒绝再次确认', async () => {
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
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        return tx.execute(sql`insert into receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by)
                       values (${tenant.id}, ${entryId}, '2026-10-05', ${admin})`);
      });

    expect(await status()).toEqual([
      { status: 'pending', amount: '500', received_on: null },
    ]);
    await settle(credit.id);
    expect(await status()).toEqual([
      { status: 'received', amount: '500', received_on: '2026-10-05' },
    ]);
    expect(await pgError(settle(credit.id))).toMatchObject({
      code: '23514',
      constraint: 'receivable_settlements_pending',
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
      withAdmin(app.db, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        return tx.execute(sql`insert into receivable_settlements (tenant_id, ledger_entry_id, received_on, confirmed_by)
                       values (${tenant.id}, ${recharge.id}, '2026-10-05', ${admin})`);
      }),
    );
    expect(error.code).toBe('23503');
  });
});

describe('同一事务的多租户流水按 tenant_id 升序加锁', () => {
  it('输入顺序相反的两个事务都先锁较小的 tenant_id，互相等待后都能提交', async () => {
    const firstTenant = await createTenant(app, 'CNY');
    const secondTenant = await createTenant(app, 'CNY');
    const [low, high] =
      firstTenant.id < secondTenant.id
        ? [firstTenant, secondTenant]
        : [secondTenant, firstTenant];
    const admin = await adminId(owner);
    const gift = (
      tenant: typeof low,
      idempotencyKey: string,
      amount: string,
    ) => ({
      tenant,
      entry: {
        kind: 'gift' as const,
        amount: money('CNY', amount),
        note: '并发加锁',
        adminId: admin,
        idempotencyKey,
      },
    });

    const holder = await owner.pool.connect();
    const jobs: Promise<unknown>[] = [];
    let markHighWaiting: () => void = () => undefined;
    const highWaiting = new Promise<void>((resolve) => {
      markHighWaiting = resolve;
    });
    let markLowWaiting: () => void = () => undefined;
    const lowWaiting = new Promise<void>((resolve) => {
      markLowWaiting = resolve;
    });
    try {
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      await holder.query('BEGIN');
      await holder.query(
        'SELECT tenant_id FROM tenant_balances WHERE tenant_id = $1 FOR UPDATE',
        [high.id],
      );

      let highFirstPid = 0;
      const highFirst = withAdmin(app.db, async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        highFirstPid = pid.rows[0]!.pid;
        markHighWaiting();
        return appendLedgerEntries(tx, [
          gift(high, 'order-high-20', '20'),
          gift(low, 'order-low-10', '10'),
        ]);
      });
      jobs.push(highFirst);
      await highWaiting;
      await waitUntilBlocked(highFirstPid, holderPid);

      let lowFirstPid = 0;
      const lowFirst = withAdmin(app.db, async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        lowFirstPid = pid.rows[0]!.pid;
        markLowWaiting();
        return appendLedgerEntries(tx, [
          gift(low, 'order-low-1', '1'),
          gift(high, 'order-high-2', '2'),
        ]);
      });
      jobs.push(lowFirst);
      await lowWaiting;
      await waitUntilBlocked(lowFirstPid, highFirstPid);

      await holder.query('COMMIT');
      await highFirst;
      await lowFirst;

      const { rows } = await owner.pool.query(
        `SELECT tenant_id, balance::text
         FROM tenant_balances
         WHERE tenant_id = ANY($1::uuid[])
         ORDER BY tenant_id`,
        [[low.id, high.id]],
      );
      expect(rows).toEqual([
        { tenant_id: low.id, balance: '11' },
        { tenant_id: high.id, balance: '22' },
      ]);
      expect(
        (await owner.pool.query('SELECT code FROM balance_discrepancies')).rows,
      ).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(jobs);
      holder.release();
    }
  });

  it('去掉连字符或加上花括号后，仍先锁较小的 uuid', async () => {
    const lowId = '00000000-0000-4000-8000-0000000000a1';
    const highId = '00000000-0000-4000-8000-0000000000a2';
    await owner.pool.query(
      `INSERT INTO tenants (id, code, name, currency, overdraft_limit) VALUES
         ($1, 'ORDLOWA1', '低位', 'CNY', 0),
         ($2, 'ORDHIGHA2', '高位', 'CNY', 0)`,
      [lowId, highId],
    );
    const admin = await adminId(owner);
    const gift = (id: string, idempotencyKey: string, amount: string) => ({
      tenant: { id, currency: 'CNY' as const },
      entry: {
        kind: 'gift' as const,
        amount: money('CNY', amount),
        note: '规范 UUID 排序',
        adminId: admin,
        idempotencyKey,
      },
    });
    // 只转小写时，较大的 uuid 排在花括号或无连字符的较小 uuid 前面。
    expect(highId < `{${lowId}}`).toBe(true);
    expect(highId < lowId.replaceAll('-', '')).toBe(true);

    const holder = await owner.pool.connect();
    const jobs: Promise<unknown>[] = [];
    let markPlainWaiting: () => void = () => undefined;
    const plainWaiting = new Promise<void>((resolve) => {
      markPlainWaiting = resolve;
    });
    let markCanonicalWaiting: () => void = () => undefined;
    const canonicalWaiting = new Promise<void>((resolve) => {
      markCanonicalWaiting = resolve;
    });
    try {
      const holderPid = (
        await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      await holder.query('BEGIN');
      await holder.query(
        'SELECT tenant_id FROM tenant_balances WHERE tenant_id = $1 FOR UPDATE',
        [highId],
      );

      let plainPid = 0;
      const plainForms = withAdmin(app.db, async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        plainPid = pid.rows[0]!.pid;
        markPlainWaiting();
        return appendLedgerEntries(tx, [
          gift(highId, 'plain-high-20', '20'),
          gift(`{${lowId}}`, 'plain-low-10', '10'),
        ]);
      });
      jobs.push(plainForms);
      await plainWaiting;
      await waitUntilBlocked(plainPid, holderPid);

      let canonicalPid = 0;
      const canonicalForms = withAdmin(app.db, async (tx) => {
        const pid = await tx.execute<{ pid: number }>(
          sql`select pg_backend_pid() as pid`,
        );
        canonicalPid = pid.rows[0]!.pid;
        markCanonicalWaiting();
        return appendLedgerEntries(tx, [
          gift(highId, 'canon-high-2', '2'),
          gift(lowId.replaceAll('-', ''), 'canon-low-1', '1'),
        ]);
      });
      jobs.push(canonicalForms);
      await canonicalWaiting;
      await waitUntilBlocked(canonicalPid, plainPid);

      await holder.query('COMMIT');
      const written = await plainForms;
      await canonicalForms;
      expect(written.map((row) => row.tenantId)).toEqual([lowId, highId]);

      const { rows } = await owner.pool.query(
        `SELECT tenant_id, balance::text
         FROM tenant_balances
         WHERE tenant_id = ANY($1::uuid[])
         ORDER BY tenant_id`,
        [[lowId, highId]],
      );
      expect(rows).toEqual([
        { tenant_id: lowId, balance: '11' },
        { tenant_id: highId, balance: '22' },
      ]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await Promise.allSettled(jobs);
      holder.release();
    }
  });

  it('同一事务再写更小的 tenant_id 时拒绝，这次调用的流水全部回滚', async () => {
    const firstTenant = await createTenant(app, 'CNY');
    const secondTenant = await createTenant(app, 'CNY');
    const [low, high] =
      firstTenant.id < secondTenant.id
        ? [firstTenant, secondTenant]
        : [secondTenant, firstTenant];
    const admin = await adminId(owner);
    const gift = (
      tenant: typeof low,
      idempotencyKey: string,
      amount: string,
    ) => ({
      tenant,
      entry: {
        kind: 'gift' as const,
        amount: money('CNY', amount),
        note: '不能回头加锁',
        adminId: admin,
        idempotencyKey,
      },
    });

    const error = await pgError(
      withAdmin(app.db, async (tx) => {
        await appendLedgerEntries(tx, [gift(high, 'back-high', '5')]);
        await appendLedgerEntries(tx, [gift(low, 'back-low', '7')]);
      }),
    );
    expect(error).toMatchObject({
      code: '55000',
      message: `租户 ${low.id} 早于本事务已锁的租户 ${high.id}：同一事务的租户要在一次 lock_tenants 调用里加锁`,
    });

    await withAdmin(app.db, (tx) =>
      appendLedgerEntries(tx, [
        gift(high, 'after-high', '4'),
        gift(low, 'after-low', '3'),
      ]),
    );
    const { rows } = await owner.pool.query(
      `SELECT tenant_id, balance::text
       FROM tenant_balances
       WHERE tenant_id = ANY($1::uuid[])
       ORDER BY tenant_id`,
      [[low.id, high.id]],
    );
    expect(rows).toEqual([
      { tenant_id: low.id, balance: '3' },
      { tenant_id: high.id, balance: '4' },
    ]);
  });

  it('非法 tenant_id 在写入之前被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const gift = (id: string, idempotencyKey: string) => ({
      tenant: { id, currency: tenant.currency },
      entry: {
        kind: 'gift' as const,
        amount: money(tenant.currency, '9'),
        note: '非法 UUID',
        adminId: admin,
        idempotencyKey,
      },
    });
    const { error, rows } = await withAdmin(app.db, async (tx) => {
      const error = await appendLedgerEntries(tx, [
        gift(tenant.id, 'valid-before-invalid'),
        gift('not-a-uuid', 'invalid-tenant'),
      ]).catch((rejected: unknown) => rejected);
      const { rows } = await tx.execute(
        sql`select count(*)::int as entries, (select balance::text from tenant_balances where tenant_id = ${tenant.id}) as balance
            from ledger_entries where tenant_id = ${tenant.id}`,
      );
      return { error, rows };
    });
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      'tenant_id 不是合法的 UUID：not-a-uuid',
    );
    expect(rows).toEqual([{ entries: 0, balance: '0' }]);
  });

  it('同一事务对同一个租户写两次仍然成功', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const gift = (idempotencyKey: string, amount: string) => ({
      kind: 'gift' as const,
      amount: money('CNY', amount),
      note: '同一租户',
      adminId: admin,
      idempotencyKey,
    });
    await withAdmin(app.db, async (tx) => {
      await appendLedgerEntry(tx, tenant, gift('same-1', '1'));
      await appendLedgerEntry(tx, tenant, gift('same-2', '2'));
    });
    const { rows } = await owner.pool.query(
      'SELECT balance::text FROM tenant_balances WHERE tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([{ balance: '3' }]);
  });
});

describe('同一租户的写入在租户锁上串行', () => {
  const giftOf = (admin: string, idempotencyKey: string, amount: string) => ({
    kind: 'gift' as const,
    amount: money('CNY', amount),
    note: '租户锁',
    adminId: admin,
    idempotencyKey,
  });

  it('A 写幂等键 a、b，B 写 b：B 排队，A 提交后 B 拿回 A 写的 b', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const wroteA = deferred();
    const release = deferred();
    const secondPid = deferred<number>();
    const first = adminTransaction(app.db, async (tx) => {
      await appendLedgerEntry(tx, tenant, giftOf(admin, 'key-a', '1'));
      wroteA.resolve();
      await release.promise;
      return appendLedgerEntry(tx, tenant, giftOf(admin, 'key-b', '2'));
    });
    let second: Promise<unknown> = Promise.resolve();
    try {
      await Promise.race([wroteA.promise, first]);
      second = adminTransaction(app.db, async (tx) => {
        secondPid.resolve(await backendPid(tx));
        return appendLedgerEntries(tx, [
          { tenant, entry: giftOf(admin, 'key-b', '2') },
        ]);
      });
      await waitForTenantLock(owner, await secondPid.promise, tenant.id);
      release.resolve();
      const firstB = await first;
      expect((await second) as unknown[]).toEqual([firstB]);
      const { rows } = await owner.pool.query(
        'SELECT balance::text FROM tenant_balances WHERE tenant_id = $1',
        [tenant.id],
      );
      expect(rows).toEqual([{ balance: '3' }]);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });

  it('A 锁两个租户、改低位费率并给两边记账，B 给两边记账：B 在低位租户的锁上排队，两边都提交', async () => {
    const firstTenant = await createTenant(app, 'CNY');
    const secondTenant = await createTenant(app, 'CNY');
    const [low, high] =
      firstTenant.id < secondTenant.id
        ? [firstTenant, secondTenant]
        : [secondTenant, firstTenant];
    const admin = await adminId(owner);
    const wroteHigh = deferred();
    const release = deferred();
    const secondPid = deferred<number>();
    const first = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [high.id, low.id]);
      await appendLedgerEntry(tx, high, giftOf(admin, 'a-high', '20'));
      wroteHigh.resolve();
      await release.promise;
      await createRateVersion(tx, low.id, [], {
        effectiveFrom: new Date('2031-01-01T00:00:00Z'),
      });
      await appendLedgerEntry(tx, low, giftOf(admin, 'a-low', '10'));
    });
    let second: Promise<unknown> = Promise.resolve();
    try {
      await Promise.race([wroteHigh.promise, first]);
      second = adminTransaction(app.db, async (tx) => {
        secondPid.resolve(await backendPid(tx));
        await appendLedgerEntries(tx, [
          { tenant: high, entry: giftOf(admin, 'b-high', '2') },
          { tenant: low, entry: giftOf(admin, 'b-low', '1') },
        ]);
      });
      await waitForTenantLock(owner, await secondPid.promise, low.id);
      release.resolve();
      await first;
      await second;
      const { rows } = await owner.pool.query(
        `SELECT tenant_id, balance::text,
                (SELECT count(*)::int FROM rate_versions v WHERE v.tenant_id = b.tenant_id) AS versions
         FROM tenant_balances b
         WHERE tenant_id = ANY($1::uuid[])
         ORDER BY tenant_id`,
        [[low.id, high.id]],
      );
      expect(rows).toEqual([
        { tenant_id: low.id, balance: '11', versions: 1 },
        { tenant_id: high.id, balance: '22', versions: 0 },
      ]);
    } finally {
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  });
});

describe('缓存余额可重算核对', () => {
  it('显式事务里 CALL rebuild_tenant_balances 报 2D000，不提交外层修改', async () => {
    const tenant = await createTenant(app, 'CNY');
    const client = await owner.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE tenants SET remark = $2 WHERE id = $1', [
        tenant.id,
        'should-rollback',
      ]);
      const error = await pgError(
        client.query('CALL rebuild_tenant_balances(NULL)'),
      );
      expect(error.code).toBe('2D000');
      await client.query('ROLLBACK');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    const { rows } = await owner.pool.query(
      'SELECT remark FROM tenants WHERE id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([{ remark: '' }]);
  });

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
      (await owner.pool.query('CALL rebuild_tenant_balances(NULL)')).rows,
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
      await charging.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [
        tenant.id,
      ]);
      await charging.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -5, 'call:interleaved')`,
        [tenant.id],
      );
      const { rows } = await rebuilding.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid',
      );
      const rebuilt = rebuilding.query('CALL rebuild_tenant_balances(NULL)');
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

  it('A 持有余额行锁时 B 开始重算，等待期间 C 开户 Q6NEW 并留下未提交扣费：结束后缓存与流水合计都是 -25', async () => {
    const holder = await owner.pool.connect();
    const rebuilding = await owner.pool.connect();
    const opener = await owner.pool.connect();
    let rebuilt: Promise<unknown> = Promise.resolve();
    try {
      const pidOf = async (client: typeof holder) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
      const holderPid = await pidOf(holder);
      const rebuildingPid = await pidOf(rebuilding);
      const openerPid = await pidOf(opener);

      await holder.query('BEGIN');
      await holder.query(
        'SELECT tenant_id FROM tenant_balances ORDER BY tenant_id FOR UPDATE',
      );
      rebuilt = rebuilding.query('CALL rebuild_tenant_balances(NULL)');
      await waitUntilBlocked(rebuildingPid, holderPid);

      const {
        rows: [created],
      } = await opener.query<{ id: string }>(
        `INSERT INTO tenants (code, name, currency, overdraft_limit)
         VALUES ('Q6NEW', '并发开户', 'CNY', 0)
         RETURNING id`,
      );
      await opener.query('BEGIN');
      await opener.query(`SELECT set_config('app.scope', 'system', true)`);
      await opener.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [
        created!.id,
      ]);
      await opener.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -20, 'call:q6new-20')`,
        [created!.id],
      );
      await opener.query('COMMIT');
      await opener.query(
        'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = $1',
        [created!.id],
      );
      await opener.query('BEGIN');
      await opener.query(`SELECT set_config('app.scope', 'system', true)`);
      await opener.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [
        created!.id,
      ]);
      await opener.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -5, 'call:q6new-5')`,
        [created!.id],
      );

      await holder.query('ROLLBACK');
      await waitUntilBlocked(rebuildingPid, openerPid);
      await opener.query('COMMIT');
      await rebuilt;

      const { rows } = await owner.pool.query(
        `SELECT t.code,
                b.balance::text AS cached,
                (SELECT sum(e.amount)::text FROM ledger_entries e WHERE e.tenant_id = t.id) AS ledger_total
         FROM tenants t
         JOIN tenant_balances b ON b.tenant_id = t.id
         WHERE t.code = 'Q6NEW'`,
      );
      expect(rows).toEqual([
        { code: 'Q6NEW', cached: '-25', ledger_total: '-25' },
      ]);
      expect(
        (await owner.pool.query('SELECT code FROM balance_discrepancies')).rows,
      ).toEqual([]);
    } finally {
      await holder.query('ROLLBACK');
      await opener.query('ROLLBACK');
      await rebuilt.catch(() => undefined);
      holder.release();
      rebuilding.release();
      opener.release();
    }
  });

  it('先改租户，再重算，再写流水：两边都进入锁等待，提交后缓存等于流水合计', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    await withAdmin(app.db, (tx) =>
      appendLedgerEntry(tx, tenant, {
        kind: 'gift',
        amount: money('CNY', '20'),
        note: '线路故障补偿',
        adminId: admin,
        idempotencyKey: 'gift-before-rebuild',
      }),
    );
    await owner.pool.query(
      'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = $1',
      [tenant.id],
    );

    const writer = await owner.pool.connect();
    const holder = await owner.pool.connect();
    const rebuilding = await owner.pool.connect();
    let rebuilt: Promise<unknown> = Promise.resolve();
    let inserted: Promise<unknown> = Promise.resolve();
    try {
      const pidOf = async (client: typeof writer) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
      const writerPid = await pidOf(writer);
      const holderPid = await pidOf(holder);
      const rebuildingPid = await pidOf(rebuilding);

      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.scope', 'system', true)`);
      await writer.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenant.id]);
      await writer.query('UPDATE tenants SET remark = remark WHERE id = $1', [
        tenant.id,
      ]);
      await holder.query('BEGIN');
      await holder.query(
        'SELECT tenant_id FROM tenant_balances WHERE tenant_id = $1 FOR UPDATE',
        [tenant.id],
      );
      rebuilt = rebuilding.query('CALL rebuild_tenant_balances(NULL)');
      await waitUntilBlocked(rebuildingPid, holderPid);
      inserted = writer.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -7, 'call:tenant-then-rebuild')`,
        [tenant.id],
      );
      await waitUntilBlocked(writerPid, rebuildingPid);
      await holder.query('ROLLBACK');
      await inserted;
      await writer.query('COMMIT');
      await rebuilt;

      const { rows } = await owner.pool.query(
        `SELECT balance::text AS cached,
                (SELECT coalesce(sum(amount), 0)::text FROM ledger_entries WHERE tenant_id = $1) AS ledger_total
         FROM tenant_balances WHERE tenant_id = $1`,
        [tenant.id],
      );
      expect(rows).toEqual([{ cached: '13', ledger_total: '13' }]);
      expect(
        (await owner.pool.query('SELECT code FROM balance_discrepancies')).rows,
      ).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await inserted.catch(() => undefined);
      await rebuilt.catch(() => undefined);
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      holder.release();
      rebuilding.release();
    }
  });

  it('重算等在高位租户上时，中途开户并按 tenant_id 升序扣两个租户，不发生死锁', async () => {
    const lowId = '00000000-0000-0000-0000-000000000012';
    const midId = 'ffffffff-ffff-ffff-ffff-fffffffffff2';
    const highId = 'ffffffff-ffff-ffff-ffff-fffffffffff3';
    await owner.pool.query(
      `INSERT INTO tenants (id, code, name, currency, overdraft_limit) VALUES
         ($1, 'TENB2', '乙', 'CNY', 0),
         ($2, 'TENC3', '丙', 'CNY', 0)`,
      [midId, highId],
    );
    await owner.pool.query(
      'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = ANY($1::uuid[])',
      [[midId, highId]],
    );

    const holder = await owner.pool.connect();
    const rebuilding = await owner.pool.connect();
    const writer = await owner.pool.connect();
    let rebuilt: Promise<unknown> = Promise.resolve();
    try {
      const pidOf = async (client: typeof holder) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
      const holderPid = await pidOf(holder);
      const rebuildingPid = await pidOf(rebuilding);
      const writerPid = await pidOf(writer);

      await holder.query('BEGIN');
      await holder.query(`SELECT set_config('app.scope', 'system', true)`);
      await holder.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [highId]);
      await holder.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -4, 'call:high-open')`,
        [highId],
      );
      rebuilt = rebuilding.query('CALL rebuild_tenant_balances(NULL)');
      await waitUntilBlocked(rebuildingPid, holderPid);

      await writer.query(
        `INSERT INTO tenants (id, code, name, currency, overdraft_limit)
         VALUES ($1, 'TENA12', '甲', 'CNY', 0)`,
        [lowId],
      );
      await writer.query(
        'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = $1',
        [lowId],
      );
      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.scope', 'system', true)`);
      await writer.query('SELECT lock_tenants(ARRAY[$1, $2]::uuid[])', [
        lowId,
        midId,
      ]);
      await writer.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -8, 'call:low-open')`,
        [lowId],
      );
      await writer.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -3, 'call:mid-open')`,
        [midId],
      );
      const { rows: waiting } = await owner.pool.query<{ blocked: boolean }>(
        'SELECT $2::integer = ANY (pg_blocking_pids($1)) AS blocked',
        [writerPid, rebuildingPid],
      );
      expect(waiting).toEqual([{ blocked: false }]);

      await holder.query('COMMIT');
      await waitUntilBlocked(rebuildingPid, writerPid);
      await writer.query('COMMIT');
      await rebuilt;

      const { rows } = await owner.pool.query(
        `SELECT t.code, b.balance::text AS cached,
                (SELECT coalesce(sum(e.amount), 0)::text FROM ledger_entries e WHERE e.tenant_id = t.id) AS ledger_total
         FROM tenants t
         JOIN tenant_balances b ON b.tenant_id = t.id
         WHERE t.id = ANY($1::uuid[])
         ORDER BY t.id`,
        [[lowId, midId, highId]],
      );
      expect(rows).toEqual([
        { code: 'TENA12', cached: '-8', ledger_total: '-8' },
        { code: 'TENB2', cached: '-3', ledger_total: '-3' },
        { code: 'TENC3', cached: '-4', ledger_total: '-4' },
      ]);
      expect(
        (await owner.pool.query('SELECT code FROM balance_discrepancies')).rows,
      ).toEqual([]);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await writer.query('ROLLBACK').catch(() => undefined);
      await rebuilt.catch(() => undefined);
      holder.release();
      rebuilding.release();
      writer.release();
    }
  });

  it('先扣高位租户再扣低位租户，与重算交错，不发生死锁且缓存等于流水合计', async () => {
    const lowId = '00000000-0000-0000-0000-000000000011';
    const highId = 'ffffffff-ffff-ffff-ffff-fffffffffff1';
    await owner.pool.query(
      `INSERT INTO tenants (id, code, name, currency, overdraft_limit) VALUES
         ($1, 'LOW011', '低位', 'CNY', 0),
         ($2, 'HIGHF1', '高位', 'CNY', 0)`,
      [lowId, highId],
    );
    await owner.pool.query(
      'UPDATE tenant_balances SET balance = 999 WHERE tenant_id = ANY($1::uuid[])',
      [[lowId, highId]],
    );

    const writer = await owner.pool.connect();
    const rebuilding = await owner.pool.connect();
    let rebuilt: Promise<unknown> = Promise.resolve();
    try {
      const pidOf = async (client: typeof writer) =>
        (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
          .rows[0]!.pid;
      const writerPid = await pidOf(writer);
      const rebuildingPid = await pidOf(rebuilding);

      await writer.query('BEGIN');
      await writer.query(`SELECT set_config('app.scope', 'system', true)`);
      await writer.query('SELECT lock_tenants(ARRAY[$1, $2]::uuid[])', [
        highId,
        lowId,
      ]);
      await writer.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -1, 'call:high-then-low')`,
        [highId],
      );
      rebuilt = rebuilding.query('CALL rebuild_tenant_balances(NULL)');
      await waitUntilBlocked(rebuildingPid, writerPid);
      await writer.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key)
         VALUES ($1, 'call_charge', -2, 'call:low-while-rebuild')`,
        [lowId],
      );
      const { rows: still } = await owner.pool.query<{ blocked: boolean }>(
        'SELECT $2::integer = ANY (pg_blocking_pids($1)) AS blocked',
        [rebuildingPid, writerPid],
      );
      expect(still).toEqual([{ blocked: true }]);
      await writer.query('COMMIT');
      await rebuilt;

      const { rows } = await owner.pool.query(
        `SELECT t.code, b.balance::text AS cached,
                (SELECT coalesce(sum(e.amount), 0)::text FROM ledger_entries e WHERE e.tenant_id = t.id) AS ledger_total
         FROM tenants t
         JOIN tenant_balances b ON b.tenant_id = t.id
         WHERE t.id = ANY($1::uuid[])
         ORDER BY t.id`,
        [[lowId, highId]],
      );
      expect(rows).toEqual([
        { code: 'LOW011', cached: '-2', ledger_total: '-2' },
        { code: 'HIGHF1', cached: '-1', ledger_total: '-1' },
      ]);
      expect(
        (await owner.pool.query('SELECT code FROM balance_discrepancies')).rows,
      ).toEqual([]);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await rebuilt.catch(() => undefined);
      writer.release();
      rebuilding.release();
    }
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
