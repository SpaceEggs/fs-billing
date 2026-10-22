import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { adminId, connections, pgError } from '../../test/support.js';
import {
  ensureStatementPartitions,
  statementCall,
  statementLedger,
  statementTenant,
} from '../../test/statements.js';
import { withAdmin, withSystem } from '../client.js';
import { NotFoundError } from '../errors.js';
import {
  generateStatement,
  readStatement,
  regenerateStatement,
  StatementError,
} from './index.js';

const { app, owner } = connections();
let administrator: string;
beforeAll(async () => {
  administrator = await adminId(owner);
  await ensureStatementPartitions(app);
});

const snapshot = { isolationLevel: 'repeatable read' } as const;
const generate = (tenant: string, month: string) =>
  withSystem(app.db, (tx) => generateStatement(tx, tenant, month), snapshot);
const regenerate = (tenant: string, month: string, expectedVersion: number) =>
  withAdmin(
    app.db,
    (tx) =>
      regenerateStatement(tx, tenant, month, {
        expectedVersion,
        adminId: administrator,
      }),
    snapshot,
  );
const read = (tenant: string, month: string) =>
  withAdmin(app.db, (tx) => readStatement(tx, tenant, month));

async function septemberTenant() {
  const tenant = await statementTenant(owner, {
    createdAt: '2026-08-20 08:00:00',
  });
  await statementLedger(
    owner,
    tenant.id,
    'recharge',
    '100',
    '2026-09-01 09:00:00',
    {
      adminId: administrator,
    },
  );
  await statementCall(owner, tenant.id, {
    answeredAt: '2026-09-10 10:00:00',
    minutes: '2',
    charge: '0.5',
  });
  return tenant;
}

describe('手动重新生成（验收标准 5）', () => {
  it('a late call charge then regeneration updates the figures, bumps the version and appends the new breakdown', async () => {
    const tenant = await septemberTenant();
    const first = await generate(tenant.id, '2026-09-01');
    if (first.outcome !== 'created') throw new Error('期望新建账单');
    expect(first.statement).toMatchObject({
      version: 1,
      callCharges: '0.5',
      closingBalance: '99.5',
      calls: 1,
    });

    // 话单补推：9 月的一通电话，扣费在 10 月才写入。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-11 11:00:00',
      minutes: '4',
      charge: '1.25',
      ledgerCreatedAt: '2026-10-20 09:00:00',
    });
    const result = await regenerate(tenant.id, '2026-09-01', 1);
    expect(result).toMatchObject({
      changed: true,
      created: false,
      before: {
        version: 1,
        callCharges: '0.5',
        closingBalance: '99.5',
        calls: 1,
        callMinutes: '2',
      },
      after: {
        version: 2,
        callCharges: '1.75',
        closingBalance: '98.25',
        calls: 2,
        callMinutes: '6',
      },
    });
    expect(result.statement).toMatchObject({
      version: 2,
      generatedBy: administrator,
      reconcileStatus: 'unchecked',
      reconciledAt: null,
      reconcileDiff: null,
    });
    expect(
      result.statement.days.map((d) => [d.day, d.calls, d.charge]),
    ).toEqual([
      ['2026-09-10', 1, '0.5'],
      ['2026-09-11', 1, '1.25'],
    ]);
    // 第一次生成的时间保留，旧版本的明细保留，读取只取当前版本。
    expect(result.statement.firstGeneratedAt).toEqual(
      first.statement.firstGeneratedAt,
    );
    expect(result.statement.generatedAt.getTime()).toBeGreaterThan(
      first.statement.generatedAt.getTime(),
    );
    const { rows } = await owner.pool.query(
      `select version, count(*)::int as days from monthly_statement_days where tenant_id = $1 group by 1 order by 1`,
      [tenant.id],
    );
    expect(rows).toEqual([
      { version: 1, days: 1 },
      { version: 2, days: 2 },
    ]);
  });

  it('an unchanged recomputation keeps the version and still reports changed false', async () => {
    const tenant = await septemberTenant();
    const first = await generate(tenant.id, '2026-09-01');
    if (first.outcome !== 'created') throw new Error('期望新建账单');
    const result = await regenerate(tenant.id, '2026-09-01', 1);
    expect(result.changed).toBe(false);
    expect(result.before).toEqual(result.after);
    expect(result.before!.version).toBe(1);
    // 什么都没写：头部原样，没有新明细。
    expect(await read(tenant.id, '2026-09-01')).toEqual(first.statement);
    const { rows } = await owner.pool.query(
      'select max(version)::int as version from monthly_statement_days where tenant_id = $1',
      [tenant.id],
    );
    expect(rows).toEqual([{ version: 1 }]);
  });

  it('a call answered after midnight belongs to the next day in the day breakdown', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-09-01 08:00:00',
    });
    await statementCall(owner, tenant.id, {
      startedAt: '2026-09-14 23:59:55',
      answeredAt: '2026-09-15 00:00:03',
      charge: '0.5',
    });
    await statementCall(owner, tenant.id, {
      startedAt: '2026-09-14 23:40:00',
      answeredAt: '2026-09-14 23:40:05',
      charge: '0.25',
    });
    const created = await regenerate(tenant.id, '2026-09-01', 0);
    expect(created.created).toBe(true);
    expect(
      created.statement.days.map((d) => [d.day, d.calls, d.charge]),
    ).toEqual([
      ['2026-09-14', 1, '0.25'],
      ['2026-09-15', 1, '0.5'],
    ]);
  });

  it('rejects expectedVersion that is stale', async () => {
    const tenant = await septemberTenant();
    await generate(tenant.id, '2026-09-01');
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-12 11:00:00',
      charge: '1',
    });
    expect((await regenerate(tenant.id, '2026-09-01', 1)).after.version).toBe(
      2,
    );
    await expect(regenerate(tenant.id, '2026-09-01', 1)).rejects.toMatchObject({
      name: 'StatementError',
      code: 'STATEMENT_VERSION_CONFLICT',
    });
    await expect(regenerate(tenant.id, '2026-09-01', 0)).rejects.toMatchObject({
      code: 'STATEMENT_VERSION_CONFLICT',
    });
    expect((await read(tenant.id, '2026-09-01'))!.version).toBe(2);
  });

  it('two administrators regenerating the same version: one wins, the other gets a version conflict', async () => {
    const tenant = await septemberTenant();
    await generate(tenant.id, '2026-09-01');
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-12 11:00:00',
      charge: '1',
    });
    const results = await Promise.allSettled([
      regenerate(tenant.id, '2026-09-01', 1),
      regenerate(tenant.id, '2026-09-01', 1),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: { code: 'STATEMENT_VERSION_CONFLICT' },
    });
    expect((await read(tenant.id, '2026-09-01'))!.version).toBe(2);
  });

  it('backfills a month that has no statement row when expectedVersion is 0', async () => {
    const tenant = await septemberTenant();
    const result = await regenerate(tenant.id, '2026-09-01', 0);
    expect(result).toMatchObject({
      created: true,
      changed: true,
      before: null,
      after: { version: 1, callCharges: '0.5', closingBalance: '99.5' },
    });
    expect(result.statement.generatedBy).toBe(administrator);
    // 已经有账单行时 0 过期。
    await expect(regenerate(tenant.id, '2026-09-01', 0)).rejects.toMatchObject({
      code: 'STATEMENT_VERSION_CONFLICT',
    });
  });

  it('rejects an unfinished month, an unknown tenant and a month before the first one', async () => {
    const tenant = await septemberTenant();
    const current = (
      await withAdmin(app.db, (tx) =>
        tx.execute<{ month: string }>(
          sql`select to_char(date_trunc('month', now() at time zone 'Asia/Shanghai'), 'YYYY-MM-DD') as month`,
        ),
      )
    ).rows[0]!.month;
    await expect(regenerate(tenant.id, current, 0)).rejects.toMatchObject({
      code: 'STATEMENT_NOT_FINAL',
    });
    await expect(regenerate(tenant.id, '2026-07-01', 0)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      regenerate('00000000-0000-4000-8000-000000000000', '2026-09-01', 0),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withAdmin(app.db, (tx) =>
        regenerateStatement(tx, tenant.id, '2026-09-01', {
          expectedVersion: 0,
          adminId: administrator,
        }),
      ),
    ).rejects.toThrow('repeatable read');
  });

  it('lists the following months whose stored opening no longer matches the ledger', async () => {
    const tenant = await statementTenant(owner, {
      createdAt: '2026-08-01 08:00:00',
    });
    await statementLedger(
      owner,
      tenant.id,
      'recharge',
      '100',
      '2026-08-02 09:00:00',
      {
        adminId: administrator,
      },
    );
    await generate(tenant.id, '2026-08-01');
    await generate(tenant.id, '2026-09-01');
    // 8 月迟到一笔扣费：8 月重新生成后，9 月存下的期初过期。
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-08-15 12:00:00',
      charge: '3',
      ledgerCreatedAt: '2026-10-20 09:00:00',
    });
    const result = await regenerate(tenant.id, '2026-08-01', 1);
    expect(result.after).toMatchObject({ closingBalance: '97' });
    expect(result.staleFollowingMonths).toEqual(['2026-09-01']);
    // 重新生成 9 月后不再过期。
    const next = await regenerate(tenant.id, '2026-09-01', 1);
    expect(next.after.openingBalance).toBe('97');
    expect(next.staleFollowingMonths).toEqual([]);
  });
});

describe('话单已删除的月份不能重新生成', () => {
  async function deletedMonth() {
    const tenant = await septemberTenant();
    await generate(tenant.id, '2026-09-01');
    await owner.pool.query(
      `update monthly_statements set details_deleted = true where tenant_id = $1`,
      [tenant.id],
    );
    return tenant;
  }

  it('rejects a details-deleted month at the service', async () => {
    const tenant = await deletedMonth();
    await statementCall(owner, tenant.id, {
      answeredAt: '2026-09-12 11:00:00',
      charge: '1',
    });
    const before = await read(tenant.id, '2026-09-01');
    await expect(regenerate(tenant.id, '2026-09-01', 1)).rejects.toMatchObject({
      name: 'StatementError',
      code: 'STATEMENT_DETAILS_DELETED',
    });
    await expect(regenerate(tenant.id, '2026-09-01', 1)).rejects.toBeInstanceOf(
      StatementError,
    );
    expect(await read(tenant.id, '2026-09-01')).toEqual(before);
  });

  it('the guard trigger rejects figure changes on a details-deleted month and a flag rollback', async () => {
    const tenant = await deletedMonth();
    const update = (set: string) =>
      pgError(
        owner.pool.query(
          `update monthly_statements set ${set} where tenant_id = $1`,
          [tenant.id],
        ),
      );
    for (const [set, message] of [
      [
        'call_charges = 9, closing_balance = 91, version = 2',
        '话单已删除的月份不能重新生成账单',
      ],
      [
        'opening_balance = 1, closing_balance = 100.5',
        '话单已删除的月份不能重新生成账单',
      ],
      ['calls = 9', '话单已删除的月份不能重新生成账单'],
      ['call_minutes = 9', '话单已删除的月份不能重新生成账单'],
      ['version = 2', '话单已删除的月份不能重新生成账单'],
      [
        "generated_at = now() + interval '1 day'",
        '话单已删除的月份不能重新生成账单',
      ],
      [`generated_by = '${administrator}'`, '话单已删除的月份不能重新生成账单'],
      ['details_deleted = false', '账单的话单已删除标志不可回退'],
    ] as const) {
      const error = await update(set);
      expect({ set, code: error.code, message: error.message }).toEqual({
        set,
        code: '23514',
        message,
      });
    }
    // 核对列仍可更新；应用角色同样受触发器约束。
    await owner.pool.query(
      `update monthly_statements set reconcile_status = 'ok', reconciled_at = now(), reconcile_diff = 0 where tenant_id = $1`,
      [tenant.id],
    );
    const viaApp = await pgError(
      withAdmin(app.db, (tx) =>
        tx.execute(
          sql`update monthly_statements set calls = 99 where tenant_id = ${tenant.id}::uuid`,
        ),
      ),
    );
    expect(viaApp.code).toBe('23514');
    expect((await read(tenant.id, '2026-09-01'))!).toMatchObject({
      calls: 1,
      detailsDeleted: true,
      reconcileStatus: 'ok',
    });
  });

  it('the guard allows setting the flag without touching the figures, and then freezes the row', async () => {
    const tenant = await septemberTenant();
    await generate(tenant.id, '2026-09-01');
    await withAdmin(app.db, (tx) =>
      tx.execute(
        sql`update monthly_statements set details_deleted = true where tenant_id = ${tenant.id}::uuid`,
      ),
    );
    expect((await read(tenant.id, '2026-09-01'))!.detailsDeleted).toBe(true);
  });

  it('the guard protects identity, version steps and the version of live rows', async () => {
    const tenant = await septemberTenant();
    await generate(tenant.id, '2026-09-01');
    const update = (set: string) =>
      pgError(
        owner.pool.query(
          `update monthly_statements set ${set} where tenant_id = $1`,
          [tenant.id],
        ),
      );
    expect((await update("month = '2026-08-01'")).message).toBe(
      '账单的编号、租户和月份不可修改',
    );
    expect((await update('id = gen_random_uuid()')).message).toBe(
      '账单的编号、租户和月份不可修改',
    );
    expect(
      (await update('call_charges = 9, closing_balance = 91')).message,
    ).toBe('账单数字变化时版本必须恰好加 1（1 → 1）');
    expect(
      (await update('call_charges = 9, closing_balance = 91, version = 3'))
        .message,
    ).toBe('账单数字变化时版本必须恰好加 1（1 → 3）');
    expect((await update('version = 5')).message).toBe(
      '账单版本只能保持或加 1（1 → 5）',
    );
    // 数字变化且版本加 1 是重新生成的形状，允许；只有版本加 1（明细变了、头部数字没变）也允许。
    await owner.pool.query(
      `update monthly_statements set call_charges = 9, closing_balance = 91, version = 2 where tenant_id = $1`,
      [tenant.id],
    );
    await owner.pool.query(
      `update monthly_statements set version = 3 where tenant_id = $1`,
      [tenant.id],
    );
    expect((await read(tenant.id, '2026-09-01'))!.version).toBe(3);
  });
});
