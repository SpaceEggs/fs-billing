import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminId, connections } from '../../test/support.js';
import {
  ensureStatementPartitions,
  statementCall,
  statementCdr,
  statementLedger,
  statementTenant,
} from '../../test/statements.js';
import { withAdmin, withSystem, withTenant } from '../client.js';
import {
  computeStatement,
  generateStatement,
  readStatement,
  type StatementComputation,
} from './index.js';

const { app, owner } = connections();
const snapshot = { isolationLevel: 'repeatable read' } as const;

let tenantId: string;

/**
 * 一个租户横跨 8、9、10 月，覆盖取数的全部边界：
 * 月初第一秒与月末最后一秒的流水、跨月接通的电话、跨午夜才扣费的电话、0 元通话、未接通话单、
 * 赊账充值、负调账、国家与日的汇总。金额都是手算的，不由被测语句推出。
 */
beforeAll(async () => {
  const administrator = await adminId(owner);
  await ensureStatementPartitions(app);
  const tenant = await statementTenant(owner, {
    createdAt: '2026-08-01 08:00:00',
  });
  tenantId = tenant.id;
  const entry = (
    kind: 'recharge' | 'credit_recharge' | 'gift' | 'adjustment',
    amount: string,
    at: string,
  ) =>
    statementLedger(owner, tenantId, kind, amount, at, {
      adminId: administrator,
    });
  // 8 月
  await entry('recharge', '100', '2026-08-10 10:00:00');
  await entry('credit_recharge', '40', '2026-08-15 12:00:00');
  await entry('adjustment', '-7.5', '2026-08-20 09:00:00');
  await entry('gift', '5', '2026-08-31 23:59:59');
  await statementCall(owner, tenantId, {
    answeredAt: '2026-08-12 10:00:00',
    minutes: '3',
    charge: '1.25',
  });
  // 9 月
  await entry('gift', '2', '2026-09-01 00:00:00');
  await entry('recharge', '50', '2026-09-20 10:00:00');
  await entry('adjustment', '-1', '2026-09-30 23:59:59');
  // 8-31 23:59:50 振铃，9-01 00:00:05 接通：归 9 月。
  await statementCall(owner, tenantId, {
    startedAt: '2026-08-31 23:59:50',
    answeredAt: '2026-09-01 00:00:05',
    minutes: '1',
    charge: '0.2',
  });
  await statementCall(owner, tenantId, {
    answeredAt: '2026-09-10 11:00:00',
    minutes: '4',
    charge: '0.6',
    country: '美国',
  });
  await statementCall(owner, tenantId, {
    answeredAt: '2026-09-10 12:00:00',
    minutes: '2',
    charge: '0.3',
  });
  // 0 元通话计入通话数与分钟数，没有扣费流水；未接通话单两者都不计。
  await statementCdr(owner, tenantId, {
    startedAt: '2026-09-15 10:00:00',
    minutes: '1',
    charge: '0',
  });
  await statementCdr(owner, tenantId, {
    startedAt: '2026-09-16 10:00:00',
    answeredAt: null,
  });
  // 9-30 23:59:30 接通，扣费流水 10-01 才写入：仍归 9 月。
  await statementCall(owner, tenantId, {
    answeredAt: '2026-09-30 23:59:30',
    minutes: '2',
    charge: '0.5',
    ledgerCreatedAt: '2026-10-01 00:00:30',
  });
  // 9-30 23:59:50 振铃，10-01 00:00:05 接通：归 10 月。
  await statementCall(owner, tenantId, {
    startedAt: '2026-09-30 23:59:50',
    answeredAt: '2026-10-01 00:00:05',
    minutes: '1',
    charge: '0.3',
  });
  // 10 月
  await entry('recharge', '20', '2026-10-05 10:00:00');
  await statementCall(owner, tenantId, {
    answeredAt: '2026-10-10 10:00:00',
    minutes: '5',
    charge: '1.1',
  });
  await statementCall(owner, tenantId, {
    answeredAt: '2026-10-25 10:00:00',
    minutes: '7',
    charge: '9',
  });
});

const compute = (
  month: string,
  options: Parameters<typeof computeStatement>[3] = {},
) => withAdmin(app.db, (tx) => computeStatement(tx, tenantId, month, options));

const generate = (month: string) =>
  withSystem(
    app.db,
    async (tx) => {
      const result = await generateStatement(tx, tenantId, month);
      if (result.outcome !== 'created') throw new Error('期望新建账单');
      return result.statement;
    },
    snapshot,
  );

/** 只取取数结果里有的字段，便于与存下的账单逐项比较。 */
const figures = (source: StatementComputation) => ({
  openingBalance: source.openingBalance,
  recharge: source.recharge,
  gift: source.gift,
  adjustment: source.adjustment,
  callCharges: source.callCharges,
  closingBalance: source.closingBalance,
  calls: source.calls,
  callMinutes: source.callMinutes,
  breakdownGap: source.breakdownGap,
  countries: source.countries,
  days: source.days,
});

const august = {
  openingBalance: '0',
  recharge: '140',
  gift: '5',
  adjustment: '-7.5',
  callCharges: '1.25',
  closingBalance: '136.25',
  calls: 1,
  callMinutes: '3',
  breakdownGap: '0',
  countries: [{ country: '中国', calls: 1, minutes: '3', charge: '1.25' }],
  days: [{ day: '2026-08-12', calls: 1, minutes: '3', charge: '1.25' }],
};

const september = {
  openingBalance: '136.25',
  recharge: '50',
  gift: '2',
  adjustment: '-1',
  callCharges: '1.6',
  closingBalance: '185.65',
  calls: 5,
  callMinutes: '10',
  breakdownGap: '0',
  countries: [
    { country: '中国', calls: 4, minutes: '6', charge: '1' },
    { country: '美国', calls: 1, minutes: '4', charge: '0.6' },
  ],
  days: [
    { day: '2026-09-01', calls: 1, minutes: '1', charge: '0.2' },
    { day: '2026-09-10', calls: 2, minutes: '6', charge: '0.9' },
    { day: '2026-09-15', calls: 1, minutes: '1', charge: '0' },
    { day: '2026-09-30', calls: 1, minutes: '2', charge: '0.5' },
  ],
};

describe('computeStatement 与存下的账单、手算的数字一致', () => {
  it('closed months equal the hand-computed figures and the statement the generator stores', async () => {
    const augustLive = await compute('2026-08-01');
    const septemberLive = await compute('2026-09-01');
    expect(figures(augustLive)).toEqual(august);
    expect(figures(septemberLive)).toEqual(september);

    await generate('2026-08-01');
    await generate('2026-09-01');
    const stored = await withAdmin(app.db, async (tx) => ({
      august: await readStatement(tx, tenantId, '2026-08-01'),
      september: await readStatement(tx, tenantId, '2026-09-01'),
    }));
    expect(figures(stored.august!)).toEqual(august);
    expect(figures(stored.september!)).toEqual(september);
    expect(figures(augustLive)).toEqual(figures(stored.august!));
    expect(figures(septemberLive)).toEqual(figures(stored.september!));
  });

  it('puts the month boundaries at Beijing midnight: the same figures come from an independent query bounded by UTC instants', async () => {
    // 北京时间 9-01 00:00 = UTC 8-31 16:00；北京时间 10-01 00:00 = UTC 9-30 16:00。
    const { rows } = await owner.pool.query<{
      kind: string;
      total: string;
    }>(
      `select kind, sum(amount)::text as total from ledger_entries
       where tenant_id = $1 and occurred_at >= '2026-08-31T16:00:00Z' and occurred_at < '2026-09-30T16:00:00Z'
       group by kind`,
      [tenantId],
    );
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.total]));
    const { rows: cdrRows } = await owner.pool.query<{
      calls: number;
      minutes: string;
    }>(
      `select count(*)::int as calls, sum(billed_minutes)::text as minutes from cdrs
       where tenant_id = $1 and answered_at >= '2026-08-31T16:00:00Z' and answered_at < '2026-09-30T16:00:00Z'`,
      [tenantId],
    );
    const live = await compute('2026-09-01');
    expect(Number(byKind['recharge'])).toBe(Number(live.recharge));
    expect(Number(byKind['gift'])).toBe(Number(live.gift));
    expect(Number(byKind['adjustment'])).toBe(Number(live.adjustment));
    expect(-Number(byKind['call_charge'])).toBeCloseTo(
      Number(live.callCharges),
      10,
    );
    expect(cdrRows[0]).toEqual({ calls: live.calls, minutes: '10' });
    // 第一秒与最后一秒的流水各归其月。
    expect(live.gift).toBe('2');
    expect(live.adjustment).toBe('-1');
  });

  it('the in-progress month agrees between the balance opening and the ledger opening, and honors asOf', async () => {
    const asOf = new Date('2026-10-20T00:00:00+08:00');
    const october = {
      openingBalance: '185.65',
      recharge: '20',
      gift: '0',
      adjustment: '0',
      callCharges: '1.4',
      closingBalance: '204.25',
      calls: 2,
      callMinutes: '6',
      breakdownGap: '0',
      countries: [{ country: '中国', calls: 2, minutes: '6', charge: '1.4' }],
      days: [
        { day: '2026-10-01', calls: 1, minutes: '1', charge: '0.3' },
        { day: '2026-10-10', calls: 1, minutes: '5', charge: '1.1' },
      ],
    };
    const viaBalance = await compute('2026-10-01', {
      asOf,
      opening: 'balance',
    });
    const viaLedger = await compute('2026-10-01', { asOf, opening: 'ledger' });
    expect(figures(viaBalance)).toEqual(october);
    expect(figures(viaLedger)).toEqual(october);
    // 到月末则 10-25 的通话也计入，期初不变。
    const wholeMonth = await compute('2026-10-01', { opening: 'balance' });
    expect(figures(wholeMonth)).toMatchObject({
      openingBalance: '185.65',
      callCharges: '10.4',
      closingBalance: '195.25',
      calls: 3,
      callMinutes: '13',
    });
    expect(figures(await compute('2026-10-01'))).toEqual(figures(wholeMonth));
  });

  it('gives the same figures under the tenant identity as under the administrator', async () => {
    const asOf = new Date('2026-10-20T00:00:00+08:00');
    const viaTenant = await withTenant(app.db, tenantId, (tx) =>
      computeStatement(tx, tenantId, '2026-10-01', {
        asOf,
        opening: 'balance',
      }),
    );
    expect(figures(viaTenant)).toEqual(
      figures(await compute('2026-10-01', { asOf, opening: 'balance' })),
    );
  });

  it('runs as a plain parameterized statement: nothing is left in pg_prepared_statements', async () => {
    // 命名（prepared）语句可能切到看不到参数值的通用计划，退回整表顺序扫描；这条语句必须每次带实参规划。
    const prepared = await withAdmin(app.db, async (tx) => {
      await computeStatement(tx, tenantId, '2026-10-01', {
        asOf: new Date('2026-10-20T00:00:00+08:00'),
        opening: 'balance',
      });
      await computeStatement(tx, tenantId, '2026-09-01');
      const { rows } = await tx.execute<{ count: number }>(
        sql`select count(*)::int as count from pg_prepared_statements`,
      );
      return rows[0]!.count;
    });
    expect(prepared).toBe(0);
  });
});
