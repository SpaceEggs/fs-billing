import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { decimal } from '@fs-billing/rating';
import {
  adminId,
  backendPid,
  connections,
  deferred,
  pgError,
  tenantId,
} from '../../test/support.js';
import {
  ensureStatementPartitions,
  statementCall,
  statementCdr,
  statementLedger,
  statementTenant,
} from '../../test/statements.js';
import { withAdmin, withSystem, type Db } from '../client.js';
import {
  computeStatement,
  firstStatementMonth,
  generateStatement,
  listMissingStatements,
  readStatement,
  StatementError,
  type StoredStatement,
} from './index.js';
import { insertStatement } from './store.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureStatementPartitions(app);
});

const snapshot = { isolationLevel: 'repeatable read' } as const;
const generate = (tenant: string, month: string, db: Db = app.db) =>
  withSystem(db, (tx) => generateStatement(tx, tenant, month), snapshot);
const read = (tenant: string, month: string) =>
  withAdmin(app.db, (tx) => readStatement(tx, tenant, month));

async function created(
  tenant: string,
  month: string,
): Promise<StoredStatement> {
  const result = await generate(tenant, month);
  if (result.outcome !== 'created')
    throw new Error(`期望新建账单，实际 ${result.outcome}`);
  return result.statement;
}

describe('ABC001 种子账单（验收标准 1）', () => {
  it('generates the ABC001 August and September statements from the seed with the mockup figures', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const august = (await read(abc001, '2026-08-01'))!;
    const september = (await read(abc001, '2026-09-01'))!;
    expect(august).toMatchObject({
      month: '2026-08-01',
      version: 1,
      openingBalance: '0',
      recharge: '3000',
      gift: '50',
      adjustment: '0',
      callCharges: '1873.4',
      closingBalance: '1176.6',
      calls: 9642,
      callMinutes: '37468',
      breakdownGap: '0',
      detailsDeleted: false,
      generatedBy: null,
    });
    expect(september).toMatchObject({
      month: '2026-09-01',
      version: 1,
      openingBalance: '1176.6',
      recharge: '1300',
      gift: '0',
      adjustment: '-25.5',
      callCharges: '2486.3',
      closingBalance: '-35.2',
      calls: 12804,
      callMinutes: '49726',
      breakdownGap: '0',
      detailsDeleted: false,
    });
    // 9 月期末就是当前余额。
    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute<{ balance: string }>(
        sql`select balance::text from tenant_balances where tenant_id = ${abc001}::uuid`,
      ),
    );
    expect(decimal(rows[0]!.balance).eq(september.closingBalance)).toBe(true);
  });

  it('matches the mockup country tables with descriptions folded into the country', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const pick = (statement: StoredStatement) =>
      statement.countries.map((c) => [c.country, c.calls, c.minutes, c.charge]);
    expect(pick((await read(abc001, '2026-09-01'))!)).toEqual([
      ['中国', 9820, '38476', '1923.8'],
      ['牙买加', 186, '900', '225'],
      ['英国', 1048, '3800', '146'],
      ['日本', 704, '2600', '91'],
      ['中国香港', 466, '1700', '51'],
      ['新加坡', 398, '1500', '42'],
      ['美国/加拿大', 182, '750', '7.5'],
    ]);
    expect(pick((await read(abc001, '2026-08-01'))!)).toEqual([
      ['中国', 7350, '28803', '1440.15'],
      ['牙买加', 145, '700', '175'],
      ['英国', 792, '2900', '108'],
      ['日本', 540, '2000', '70'],
      ['中国香港', 384, '1400', '42'],
      ['新加坡', 318, '1200', '33.6'],
      ['美国/加拿大', 113, '465', '4.65'],
    ]);
  });

  it('matches the mockup day tables: August starts on the opening day, September ends on the 29th', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const august = (await read(abc001, '2026-08-01'))!;
    const september = (await read(abc001, '2026-09-01'))!;
    expect(august.days).toHaveLength(20);
    expect([august.days[0]!.day, august.days.at(-1)!.day]).toEqual([
      '2026-08-12',
      '2026-08-31',
    ]);
    expect(august.days[0]).toMatchObject({
      calls: 163,
      minutes: '629',
      charge: '31.5',
    });
    expect(september.days).toHaveLength(29);
    expect(
      september.days
        .filter((d) => d.day >= '2026-09-23')
        .map((d) => [d.day, d.calls, d.minutes, d.charge]),
    ).toEqual([
      ['2026-09-23', 444, '1725', '86.05'],
      ['2026-09-24', 429, '1672', '83.48'],
      ['2026-09-25', 467, '1802', '90.12'],
      ['2026-09-26', 443, '1716', '85.9'],
      ['2026-09-27', 416, '1621', '81.27'],
      ['2026-09-28', 454, '1776', '88.64'],
      ['2026-09-29', 219, '843', '42.1'],
    ]);
    for (const statement of [august, september]) {
      const sum = (key: 'calls' | 'minutes' | 'charge') =>
        statement.days
          .reduce((total, day) => total.plus(day[key]), decimal('0'))
          .toFixed();
      expect([sum('calls'), sum('minutes'), sum('charge')]).toEqual([
        String(statement.calls),
        statement.callMinutes,
        statement.callCharges,
      ]);
    }
  });

  it('closing balance equals the ledger sum to month end for every seeded statement', async () => {
    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute<{ code: string; month: string; diff: string }>(sql`
        select t.code, to_char(s.month, 'YYYY-MM') as month,
          (s.closing_balance - (select coalesce(sum(l.amount), 0) from ledger_entries l
            where l.tenant_id = s.tenant_id
              and l.occurred_at < ((s.month + interval '1 month')::timestamp at time zone 'Asia/Shanghai')))::text as diff
        from monthly_statements s join tenants t on t.id = s.tenant_id
        where t.code in ('ABC001', 'HZX014', 'GZT007', 'SHC005') order by 1, 2`),
    );
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const row of rows)
      expect(decimal(row.diff).isZero(), `${row.code} ${row.month}`).toBe(true);
  });

  it('the seed generates September for every tenant that existed in September and nothing before the first month', async () => {
    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute<{ code: string; months: string }>(sql`
        select t.code, string_agg(to_char(s.month, 'YYYY-MM'), ',' order by s.month) as months
        from tenants t left join monthly_statements s on s.tenant_id = t.id
        where t.code in ('ABC001', 'GZT007', 'CDT018') group by t.code order by t.code`),
    );
    expect(rows).toEqual([
      { code: 'ABC001', months: '2026-08,2026-09' },
      { code: 'CDT018', months: null },
      { code: 'GZT007', months: '2026-09' },
    ]);
  });
});

describe('北京月归属（验收标准 3）', () => {
  it('puts a call answered on 09-30 23:59 and charged on 10-01 into September', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-30 23:59:30',
      charge: '0.5',
      ledgerCreatedAt: '2026-10-01 00:00:30',
    });
    const september = await created(tenant.id, '2026-09-01');
    expect(september).toMatchObject({
      callCharges: '0.5',
      calls: 1,
      closingBalance: '-0.5',
      breakdownGap: '0',
    });
    expect(september.days).toEqual([
      { day: '2026-09-30', calls: 1, minutes: '2', charge: '0.5' },
    ]);
    const october = await withAdmin(app.db, (tx) =>
      computeStatement(tx, tenant.id, '2026-10-01'),
    );
    expect(october).toMatchObject({
      openingBalance: '-0.5',
      callCharges: '0',
      calls: 0,
    });
  });

  it('puts a call ringing on 09-30 23:59:50 and answered on 10-01 00:00:05 into October for both ledger and breakdown', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      startedAt: '2026-09-30 23:59:50',
      answeredAt: '2026-10-01 00:00:05',
      charge: '0.3',
    });
    const september = await created(tenant.id, '2026-09-01');
    expect(september).toMatchObject({
      callCharges: '0',
      calls: 0,
      closingBalance: '0',
    });
    expect(september.days).toEqual([]);
    const october = await withAdmin(app.db, (tx) =>
      computeStatement(tx, tenant.id, '2026-10-01'),
    );
    expect(october).toMatchObject({
      openingBalance: '0',
      callCharges: '0.3',
      calls: 1,
      breakdownGap: '0',
    });
    expect(october.days.map((d) => d.day)).toEqual(['2026-10-01']);
  });

  it('puts a call ringing on 08-31 23:59:50 and answered on 09-01 00:00:05 into September, not August', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-08-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      startedAt: '2026-08-31 23:59:50',
      answeredAt: '2026-09-01 00:00:05',
      charge: '0.3',
    });
    const august = await created(tenant.id, '2026-08-01');
    const september = await created(tenant.id, '2026-09-01');
    expect([august.calls, august.callCharges]).toEqual([0, '0']);
    expect([september.calls, september.callCharges]).toEqual([1, '0.3']);
    expect(september.openingBalance).toBe('0');
    expect(september.days).toEqual([
      { day: '2026-09-01', calls: 1, minutes: '2', charge: '0.3' },
    ]);
  });

  it('ignores created_at when the entry was written months later', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-08-01 08:00:00',
    });
    await statementLedger(
      owner,
      tenant.id,
      'recharge',
      '100',
      '2026-08-10 10:00:00',
      {
        adminId: administrator,
        createdAt: '2026-08-10 10:00:00',
      },
    );
    // 8 月的扣费，十月才补写。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-08-20 12:00:00',
      charge: '1.25',
      ledgerCreatedAt: '2026-10-20 09:00:00',
    });
    const august = await created(tenant.id, '2026-08-01');
    expect(august).toMatchObject({
      recharge: '100',
      callCharges: '1.25',
      closingBalance: '98.75',
    });
    expect((await created(tenant.id, '2026-09-01')).openingBalance).toBe(
      '98.75',
    );
  });
});

describe('各项取数', () => {
  it('counts credit recharges as recharge and keeps adjustments signed', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    const entry = (
      kind: 'recharge' | 'credit_recharge' | 'gift' | 'adjustment',
      amount: string,
      at: string,
    ) =>
      statementLedger(owner, tenant.id, kind, amount, at, {
        adminId: administrator,
      });
    await entry('recharge', '100', '2026-09-02 10:00:00');
    await entry('credit_recharge', '50', '2026-09-03 10:00:00');
    await entry('gift', '10', '2026-09-04 10:00:00');
    await entry('adjustment', '5', '2026-09-05 10:00:00');
    await entry('adjustment', '-8.5', '2026-09-06 10:00:00');
    const statement = await created(tenant.id, '2026-09-01');
    expect(statement).toMatchObject({
      openingBalance: '0',
      recharge: '150',
      gift: '10',
      adjustment: '-3.5',
      callCharges: '0',
      closingBalance: '156.5',
    });
  });

  it('a void adjustment of a credit shows as a negative adjustment', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementLedger(
      owner,
      tenant.id,
      'credit_recharge',
      '500',
      '2026-09-03 10:00:00',
      {
        adminId: administrator,
      },
    );
    await statementLedger(
      owner,
      tenant.id,
      'adjustment',
      '-500',
      '2026-09-20 10:00:00',
      {
        adminId: administrator,
        note: '赊账作废',
      },
    );
    const statement = await created(tenant.id, '2026-09-01');
    expect(statement).toMatchObject({
      recharge: '500',
      adjustment: '-500',
      closingBalance: '0',
    });
  });

  it('opening balance is the ledger sum before the month, not the previous statement', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-07-01 08:00:00',
    });
    await statementLedger(
      owner,
      tenant.id,
      'recharge',
      '40',
      '2026-07-05 10:00:00',
      {
        adminId: administrator,
      },
    );
    await statementLedger(
      owner,
      tenant.id,
      'gift',
      '2.5',
      '2026-08-05 10:00:00',
      {
        adminId: administrator,
      },
    );
    // 没有 7、8 月的账单行，9 月仍然从流水得到期初。
    expect((await created(tenant.id, '2026-09-01')).openingBalance).toBe(
      '42.5',
    );
  });

  it('counts zero-charge answered calls and ignores unanswered ones', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCdr(owner, tenant.id, {
      startedAt: '2026-09-02 10:00:00',
      minutes: '1',
      charge: '0',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 11:00:00',
      minutes: '3',
      charge: '0.15',
    });
    await statementCdr(owner, tenant.id, {
      startedAt: '2026-09-02 12:00:00',
      answeredAt: null,
    });
    const statement = await created(tenant.id, '2026-09-01');
    expect(statement).toMatchObject({
      calls: 2,
      callMinutes: '4',
      callCharges: '0.15',
      breakdownGap: '0',
    });
    expect(statement.days).toEqual([
      { day: '2026-09-02', calls: 2, minutes: '4', charge: '0.15' },
    ]);
  });

  it('groups by country and folds descriptions together', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:00:00',
      minutes: '4',
      charge: '0.18',
      country: '英国',
      description: '手机',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:30:00',
      minutes: '2',
      charge: '0.04',
      country: '英国',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-03 10:00:00',
      minutes: '10',
      charge: '0.5',
    });
    expect((await created(tenant.id, '2026-09-01')).countries).toEqual([
      { country: '中国', calls: 1, minutes: '10', charge: '0.5' },
      { country: '英国', calls: 2, minutes: '6', charge: '0.22' },
    ]);
  });

  it('records the gap between the ledger and the call detail without failing', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    // 话单 0.4，流水 1：差额 0.6（例如种子里的汇总流水，或扣费还在队列里）。
    await statementCdr(owner, tenant.id, {
      startedAt: '2026-09-02 10:00:00',
      minutes: '2',
      charge: '0.4',
    });
    await statementLedger(
      owner,
      tenant.id,
      'call_charge',
      '-1',
      '2026-09-02 23:59:59',
    );
    const statement = await created(tenant.id, '2026-09-01');
    expect(statement).toMatchObject({
      callCharges: '1',
      breakdownGap: '0.6',
      closingBalance: '-1',
    });
  });

  it('keeps the exact decimals without rounding', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:00:00',
      minutes: '1',
      charge: '0.0450',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:01:00',
      minutes: '1',
      charge: '0.0285',
    });
    const statement = await created(tenant.id, '2026-09-01');
    expect(statement.callCharges).toBe('0.0735');
    expect(statement.closingBalance).toBe('-0.0735');
    expect(statement.countries[0]!.charge).toBe('0.0735');
  });
});

describe('租户第一个应有月份与缺失账单', () => {
  it('starts at the earlier of tenant creation and the first ledger entry', async () => {
    const earlyEntry = await statementTenant(owner, {
      createdAt: '2026-09-15 08:00:00',
    });
    await statementLedger(
      owner,
      earlyEntry.id,
      'recharge',
      '10',
      '2026-08-20 10:00:00',
      {
        adminId: administrator,
      },
    );
    const earlyCreation = await statementTenant(owner, {
      createdAt: '2026-08-05 08:00:00',
    });
    await statementLedger(
      owner,
      earlyCreation.id,
      'recharge',
      '10',
      '2026-09-02 10:00:00',
      {
        adminId: administrator,
      },
    );
    const first = (id: string) =>
      withAdmin(app.db, (tx) => firstStatementMonth(tx, id));
    expect(await first(earlyEntry.id)).toBe('2026-08-01');
    expect(await first(earlyCreation.id)).toBe('2026-08-01');
    expect(await first('00000000-0000-4000-8000-000000000000')).toBeNull();
    for (const tenant of [earlyEntry, earlyCreation]) {
      const missing = await withAdmin(app.db, (tx) =>
        listMissingStatements(tx, {
          tenantId: tenant.id,
          through: '2026-09-01',
        }),
      );
      expect(missing.map((m) => m.month)).toEqual(['2026-08-01', '2026-09-01']);
    }
  });

  it('creates zero statements for tenants with no activity', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-08-10 08:00:00',
      status: 'disabled',
    });
    const missing = await withAdmin(app.db, (tx) =>
      listMissingStatements(tx, { tenantId: tenant.id }),
    );
    // 默认到上一个北京月，已停用的租户也有账单。
    expect(missing.map((m) => m.month).slice(0, 2)).toEqual([
      '2026-08-01',
      '2026-09-01',
    ]);
    const statement = await created(tenant.id, '2026-08-01');
    expect(statement).toMatchObject({
      openingBalance: '0',
      recharge: '0',
      gift: '0',
      adjustment: '0',
      callCharges: '0',
      closingBalance: '0',
      calls: 0,
      callMinutes: '0',
      breakdownGap: '0',
      countries: [],
      days: [],
    });
  });

  it('skips months that already have a statement and honors the backfill limit and the last month', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-06-10 08:00:00',
    });
    await created(tenant.id, '2026-07-01');
    const month = async (options: {
      through?: string;
      backfillMonths?: number;
    }) =>
      (
        await withAdmin(app.db, (tx) =>
          listMissingStatements(tx, { tenantId: tenant.id, ...options }),
        )
      ).map((m) => m.month);
    expect(await month({ through: '2026-09-01' })).toEqual([
      '2026-06-01',
      '2026-08-01',
      '2026-09-01',
    ]);
    expect(await month({ through: '2026-09-01', backfillMonths: 2 })).toEqual([
      '2026-08-01',
      '2026-09-01',
    ]);
    expect(await month({ through: '2026-09-01', backfillMonths: 1 })).toEqual([
      '2026-09-01',
    ]);
    // 以固定的“现在”为准：2026-09-15 时上一个北京月是 8 月。
    const asOf = (
      await withAdmin(app.db, (tx) =>
        listMissingStatements(tx, {
          tenantId: tenant.id,
          asOf: new Date('2026-09-15T00:00:00+08:00'),
        }),
      )
    ).map((m) => m.month);
    expect(asOf).toEqual(['2026-06-01', '2026-08-01']);
  });
});

describe('生成只创建、重复执行结果相同（验收标准 4）', () => {
  it('running the generator twice leaves one statement and one breakdown version', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:00:00',
      charge: '0.5',
    });
    const first = await generate(tenant.id, '2026-09-01');
    const second = await generate(tenant.id, '2026-09-01');
    expect([first.outcome, second.outcome]).toEqual(['created', 'exists']);
    const counts = await owner.pool.query(
      `select
         (select count(*)::int from monthly_statements where tenant_id = $1) as statements,
         (select count(*)::int from monthly_statement_countries where tenant_id = $1) as countries,
         (select count(*)::int from monthly_statement_days where tenant_id = $1) as days,
         (select max(version)::int from monthly_statement_days where tenant_id = $1) as version`,
      [tenant.id],
    );
    expect(counts.rows).toEqual([
      { statements: 1, countries: 1, days: 1, version: 1 },
    ]);
  });

  it('a scheduled generation never overwrites an existing statement after late entries', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    const before = await created(tenant.id, '2026-09-01');
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:00:00',
      charge: '0.5',
    });
    expect((await generate(tenant.id, '2026-09-01')).outcome).toBe('exists');
    const after = (await read(tenant.id, '2026-09-01'))!;
    expect(after).toEqual(before);
  });

  it('refuses a month that has not ended and a plain read committed transaction', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    const current = (
      await withAdmin(app.db, (tx) =>
        tx.execute<{ month: string }>(
          sql`select to_char(date_trunc('month', now() at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as month`,
        ),
      )
    ).rows[0]!.month;
    await expect(generate(tenant.id, current)).rejects.toMatchObject({
      name: 'StatementError',
      code: 'STATEMENT_NOT_FINAL',
    });
    await expect(generate(tenant.id, current)).rejects.toBeInstanceOf(
      StatementError,
    );
    await expect(
      withSystem(app.db, (tx) =>
        generateStatement(tx, tenant.id, '2026-09-01'),
      ),
    ).rejects.toThrow('repeatable read');
    expect(await read(tenant.id, '2026-09-01')).toBeNull();
  });

  it('concurrent generators produce exactly one statement', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:00:00',
      charge: '0.5',
    });
    const results = await Promise.all(
      Array.from({ length: 6 }, () => generate(tenant.id, '2026-09-01')),
    );
    expect(results.filter((r) => r.outcome === 'created')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'exists')).toHaveLength(5);
    const counts = await owner.pool.query(
      `select
         (select count(*)::int from monthly_statements where tenant_id = $1) as statements,
         (select count(*)::int from monthly_statement_days where tenant_id = $1) as days`,
      [tenant.id],
    );
    expect(counts.rows).toEqual([{ statements: 1, days: 1 }]);
  });
});

describe('REPEATABLE READ 下的 ON CONFLICT DO NOTHING（设计标记为未验证的推断）', () => {
  /** 不重试的 repeatable read 系统事务：要看到原始的 40001。 */
  const rawSnapshot = <T>(
    fn: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => Promise<T>,
  ) =>
    app.db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('app.scope', 'system', true)`);
        return fn(tx);
      },
      { isolationLevel: 'repeatable read' },
    );

  it('raises 40001 when the conflicting row was committed after the snapshot, and the wrapper retry converges on exists', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    const month = '2026-09-01';

    // 原始事务：快照在先，另一个事务随后提交同一月份的账单，再 INSERT … ON CONFLICT DO NOTHING。
    const raw = await pgError(
      rawSnapshot(async (tx) => {
        await tx.execute(sql`select count(*) from monthly_statements`);
        await generate(tenant.id, month);
        const computation = await computeStatement(tx, tenant.id, month);
        return insertStatement(tx, tenant.id, month, computation, null);
      }),
    );
    expect(raw.code).toBe('40001');

    // 包装器：第一次尝试的快照看不到另一个事务的提交 → 40001 → 第二次尝试看见已有账单 → exists。
    const other = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    let attempts = 0;
    const gate = deferred();
    const wrapped = withSystem(
      app.db,
      async (tx) => {
        attempts += 1;
        await tx.execute(sql`select count(*) from monthly_statements`);
        if (attempts === 1) await gate.promise;
        return generateStatement(tx, other.id, month);
      },
      snapshot,
    );
    await generate(other.id, month);
    gate.resolve();
    expect((await wrapped).outcome).toBe('exists');
    expect(attempts).toBe(2);
  });

  it('a generator blocked on an uncommitted conflicting insert gets 40001 after the winner commits, never a silent no-op', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    const month = '2026-09-01';
    const winnerInserted = deferred();
    const winnerMayCommit = deferred();
    const loserPid = deferred<number>();

    const winner = rawSnapshot(async (tx) => {
      const computation = await computeStatement(tx, tenant.id, month);
      await insertStatement(tx, tenant.id, month, computation, null);
      winnerInserted.resolve();
      await winnerMayCommit.promise;
    });
    await winnerInserted.promise;

    const loser = pgError(
      rawSnapshot(async (tx) => {
        await tx.execute(sql`select count(*) from monthly_statements`);
        loserPid.resolve(await backendPid(tx));
        const computation = await computeStatement(tx, tenant.id, month);
        return insertStatement(tx, tenant.id, month, computation, null);
      }),
    );
    // 等到败者确实堵在胜者未提交的唯一索引项上，再让胜者提交。
    const pid = await loserPid.promise;
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rows } = await owner.pool.query<{ blocked: boolean }>(
        'select cardinality(pg_blocking_pids($1)) > 0 as blocked',
        [pid],
      );
      if (rows[0]!.blocked) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    winnerMayCommit.resolve();
    await winner;
    expect((await loser).code).toBe('40001');
    expect(
      (
        await owner.pool.query(
          'select count(*)::int as n from monthly_statements where tenant_id = $1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('a charge committed during generation never splits the header from the breakdown', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-02 10:00:00',
      charge: '0.5',
    });
    const snapshotTaken = deferred();
    const lateCommitted = deferred();
    const generating = withSystem(
      app.db,
      async (tx) => {
        await tx.execute(sql`select count(*) from ledger_entries`);
        snapshotTaken.resolve();
        await lateCommitted.promise;
        return generateStatement(tx, tenant.id, '2026-09-01');
      },
      snapshot,
    );
    await snapshotTaken.promise;
    // 生成期间提交的新扣费与话单：头部和明细要么都有，要么都没有。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-03 10:00:00',
      charge: '7',
    });
    lateCommitted.resolve();
    const result = await generating;
    if (result.outcome !== 'created') throw new Error('期望新建账单');
    expect(result.statement).toMatchObject({
      callCharges: '0.5',
      calls: 1,
      breakdownGap: '0',
    });
    expect(result.statement.days).toEqual([
      { day: '2026-09-02', calls: 1, minutes: '2', charge: '0.5' },
    ]);
    // 新扣费属于 9 月，核对前它让账单“过期”，重新生成后补上。
    const later = await withAdmin(app.db, (tx) =>
      computeStatement(tx, tenant.id, '2026-09-01'),
    );
    expect(later.callCharges).toBe('7.5');
  });
});
