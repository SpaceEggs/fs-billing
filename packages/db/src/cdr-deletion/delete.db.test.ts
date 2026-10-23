import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminId,
  adminTransaction,
  connections,
  deferred,
  pgError,
} from '../../test/support.js';
import {
  ensureStatementPartitions,
  statementLedger,
  statementTenant,
} from '../../test/statements.js';
import { chargedCall } from '../../test/unassigned.js';
import { lockTenants, withAdmin, withSystem } from '../client.js';
import {
  generateStatement,
  reconcileTenantStatements,
  regenerateStatement,
  StatementError,
} from '../statements/index.js';
import {
  CdrDeletionError,
  deleteCdrMonths,
  listCdrDeletionMonths,
  type DeleteCdrMonthsInput,
} from './index.js';

const { app, owner } = connections();
let administrator: string;
let actor: { id: string; name: string };
beforeAll(async () => {
  administrator = await adminId(owner);
  actor = { id: administrator, name: '王敏' };
  await ensureStatementPartitions(app);
});

const snapshot = { isolationLevel: 'repeatable read' } as const;

interface Fixture {
  tenant: { id: string; code: string };
  /** 8 月三通、9 月三通（含一通 8-31 23:59:50 振铃、9-01 00:00:05 接通的）。 */
  august: string[];
  september: string[];
  crossMonth: string;
}

/** 8-12 开户的租户：两个月的话单与扣费流水，账单已生成并核对为 ok。 */
async function fixture(
  options: { reconcile?: boolean } = {},
): Promise<Fixture> {
  const tenant = await statementTenant(owner, {
    createdAt: '2026-08-12 09:30:00',
  });
  await statementLedger(
    owner,
    tenant.id,
    'recharge',
    '100',
    '2026-08-12 10:00:00',
    { adminId: administrator },
  );
  const august = [
    await chargedCall(owner, tenant.id, { answeredAt: '2026-08-15 10:00:00' }),
    await chargedCall(owner, tenant.id, { answeredAt: '2026-08-20 11:00:00' }),
    await chargedCall(owner, tenant.id, { answeredAt: '2026-08-31 23:59:55' }),
  ];
  const crossMonth = await chargedCall(owner, tenant.id, {
    startedAt: '2026-08-31 23:59:50',
    answeredAt: '2026-09-01 00:00:05',
  });
  const september = [
    crossMonth,
    await chargedCall(owner, tenant.id, { answeredAt: '2026-09-05 10:00:00' }),
    await chargedCall(owner, tenant.id, { answeredAt: '2026-09-25 10:00:00' }),
  ];
  for (const month of ['2026-08-01', '2026-09-01'])
    await withSystem(
      app.db,
      (tx) => generateStatement(tx, tenant.id, month),
      snapshot,
    );
  if (options.reconcile !== false)
    await withSystem(
      app.db,
      (tx) => reconcileTenantStatements(tx, tenant.id),
      snapshot,
    );
  return { tenant, august, september, crossMonth };
}

const input = (
  f: Fixture,
  overrides: Partial<DeleteCdrMonthsInput> = {},
): DeleteCdrMonthsInput => ({
  actor,
  tenantId: f.tenant.id,
  fromMonth: '2026-08',
  toMonth: '2026-08',
  tenantCode: f.tenant.code,
  expectedCount: 3,
  ...overrides,
});

const one = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => (await owner.pool.query<T>(text, values)).rows[0]!;

/** 租户全部流水、余额、账单头部（除删除元数据）与明细的内容摘要。 */
async function ledgerAndStatements(tenantId: string) {
  return one<{
    ledger: string;
    entries: number;
    balance: string;
    headers: string;
    countries: string;
    days: string;
  }>(
    `select
       (select md5(string_agg(id::text || '|' || kind || '|' || amount::text || '|' || occurred_at::text || '|' || created_at::text || '|' || idempotency_key, ',' order by id))
          from ledger_entries where tenant_id = $1) as ledger,
       (select count(*)::int from ledger_entries where tenant_id = $1) as entries,
       (select balance::text from tenant_balances where tenant_id = $1) as balance,
       (select md5(string_agg((to_jsonb(s) - 'details_deleted' - 'details_deleted_at' - 'details_deleted_by' - 'details_deleted_count')::text, ',' order by month))
          from monthly_statements s where tenant_id = $1) as headers,
       (select md5(string_agg(to_jsonb(c)::text, ',' order by statement_id, version, country))
          from monthly_statement_countries c where tenant_id = $1) as countries,
       (select md5(string_agg(to_jsonb(d)::text, ',' order by statement_id, version, day))
          from monthly_statement_days d where tenant_id = $1) as days`,
    [tenantId],
  );
}

const cdrCountIn = async (tenantId: string, from: string, to: string) =>
  (
    await one<{ n: number }>(
      `select count(*)::int as n from cdrs
       where tenant_id = $1 and coalesce(answered_at, started_at) >= $2::timestamptz
         and coalesce(answered_at, started_at) < $3::timestamptz`,
      [tenantId, from, to],
    )
  ).n;
const augustCdrs = (tenantId: string) =>
  cdrCountIn(tenantId, '2026-07-31T16:00:00Z', '2026-08-31T16:00:00Z');
const septemberCdrs = (tenantId: string) =>
  cdrCountIn(tenantId, '2026-08-31T16:00:00Z', '2026-09-30T16:00:00Z');
const flagged = async (tenantId: string, month: string) =>
  one<{
    details_deleted: boolean;
    details_deleted_count: number | null;
    details_deleted_by: string | null;
    has_time: boolean;
  }>(
    `select details_deleted, details_deleted_count, details_deleted_by, details_deleted_at is not null as has_time
     from monthly_statements where tenant_id = $1 and month = $2`,
    [tenantId, month],
  );
const currentMonth = async () =>
  (
    await one<{ month: string }>(
      `select to_char(date_trunc('month', statement_timestamp() at time zone 'Asia/Shanghai'), 'YYYY-MM') as month`,
    )
  ).month;

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CdrDeletionError)
      return { code: error.code, month: error.month };
    throw error;
  }
  throw new Error('期望删除被拒绝，但它成功了');
}

describe('月份状态', () => {
  it('lists the twelve months of a year with their states', async () => {
    const f = await fixture();
    const months = await withAdmin(app.db, (tx) =>
      listCdrDeletionMonths(tx, { tenantId: f.tenant.id, year: 2026 }),
    );
    expect(months).toHaveLength(12);
    expect(
      months.slice(0, 9).map((m) => [m.month, m.state, m.cdrCount]),
    ).toEqual([
      ['2026-01', 'before_opening', null],
      ['2026-02', 'before_opening', null],
      ['2026-03', 'before_opening', null],
      ['2026-04', 'before_opening', null],
      ['2026-05', 'before_opening', null],
      ['2026-06', 'before_opening', null],
      ['2026-07', 'before_opening', null],
      // 8-31 23:59:50 振铃、9-01 00:00:05 接通的话单按接通月归 9 月。
      ['2026-08', 'deletable', 3],
      ['2026-09', 'deletable', 3],
    ]);
    const current = await currentMonth();
    for (const month of months.slice(9)) {
      const expected = month.month > current ? 'future' : 'no_statement';
      expect({ month: month.month, state: month.state }).toEqual({
        month: month.month,
        state: expected,
      });
      expect(month.cdrCount).toBeNull();
    }
    expect(months[7]).toMatchObject({ blockedReasons: [], deleted: null });
    expect(typeof months[7]!.statementId).toBe('string');
  });

  it('marks months blocked while a charge is missing or the reconcile status is not ok', async () => {
    const f = await fixture();
    // 9 月有一通已有费用而没有流水的话单。
    const missing = await chargedCall(owner, f.tenant.id, {
      answeredAt: '2026-09-28 10:00:00',
      ledger: false,
    });
    await owner.pool.query(
      `update monthly_statements set reconcile_status = 'stale' where tenant_id = $1 and month = '2026-08-01'`,
      [f.tenant.id],
    );
    const [august, september] = (
      await withAdmin(app.db, (tx) =>
        listCdrDeletionMonths(tx, { tenantId: f.tenant.id, year: 2026 }),
      )
    ).slice(7, 9);
    expect(august).toMatchObject({
      state: 'blocked',
      blockedReasons: ['reconcile_not_ok'],
      cdrCount: 3,
    });
    expect(september).toMatchObject({
      state: 'blocked',
      blockedReasons: ['uncharged_calls'],
      cdrCount: 4,
    });
    expect(missing).toBeTruthy();
  });
});

describe('删除话单', () => {
  it('rejects the current month and a month without a statement', async () => {
    const f = await fixture();
    const current = await currentMonth();
    const before = await ledgerAndStatements(f.tenant.id);
    const rejected = [
      // 当前月（没有账单行）。
      await codeOf(
        deleteCdrMonths(
          app.db,
          input(f, { fromMonth: current, toMonth: current, expectedCount: 0 }),
        ),
      ),
      // 早于开户月。
      await codeOf(
        deleteCdrMonths(
          app.db,
          input(f, {
            fromMonth: '2026-07',
            toMonth: '2026-07',
            expectedCount: 0,
          }),
        ),
      ),
      // 晚于当前月。
      await codeOf(
        deleteCdrMonths(
          app.db,
          input(f, {
            fromMonth: '2099-01',
            toMonth: '2099-01',
            expectedCount: 0,
          }),
        ),
      ),
    ];
    expect(rejected).toEqual([
      { code: 'CDR_MONTH_NOT_DELETABLE', month: current },
      { code: 'CDR_MONTH_NOT_DELETABLE', month: '2026-07' },
      { code: 'CDR_MONTH_NOT_DELETABLE', month: '2099-01' },
    ]);
    expect(await augustCdrs(f.tenant.id)).toBe(3);
    expect(await septemberCdrs(f.tenant.id)).toBe(3);
    expect(await ledgerAndStatements(f.tenant.id)).toEqual(before);
  });

  it('rejects the whole range when one month is not deletable and deletes nothing', async () => {
    const f = await fixture();
    const current = await currentMonth();
    expect(
      await codeOf(
        deleteCdrMonths(
          app.db,
          input(f, {
            fromMonth: '2026-08',
            toMonth: current,
            expectedCount: 6,
          }),
        ),
      ),
    ).toEqual({ code: 'CDR_MONTH_NOT_DELETABLE', month: '2026-10' });
    expect(await augustCdrs(f.tenant.id)).toBe(3);
    expect(await septemberCdrs(f.tenant.id)).toBe(3);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      false,
    );
  });

  it('deleting August leaves the ledger, balance, statement header and breakdown unchanged', async () => {
    const f = await fixture();
    const before = await ledgerAndStatements(f.tenant.id);
    expect(before.entries).toBe(7);

    const result = await deleteCdrMonths(app.db, input(f));
    expect(result).toMatchObject({
      total: 3,
      remaining: [],
      failure: null,
      months: [{ month: '2026-08', deleted: 3 }],
    });

    // 只有话单没了：8 月三条删除，9 月三条（含跨月的一通）原样在。
    expect(await augustCdrs(f.tenant.id)).toBe(0);
    expect(await septemberCdrs(f.tenant.id)).toBe(3);
    expect(
      (
        await owner.pool.query(
          `select count(*)::int as n from cdrs where call_uuid = $1`,
          [f.crossMonth],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
    // 流水、余额、账单头部（除删除元数据）、国家表与日表一个字节都没变。
    expect(await ledgerAndStatements(f.tenant.id)).toEqual(before);
    // 账单头部记下了谁、何时、多少条。
    expect(await flagged(f.tenant.id, '2026-08-01')).toEqual({
      details_deleted: true,
      details_deleted_count: 3,
      details_deleted_by: administrator,
      has_time: true,
    });
    expect((await flagged(f.tenant.id, '2026-09-01')).details_deleted).toBe(
      false,
    );
    // 通话 UUID 的登记保留。
    expect(
      (
        await owner.pool.query(
          `select count(*)::int as n from call_uuids where call_uuid = any($1::uuid[]) and tenant_id = $2`,
          [f.august, f.tenant.id],
        )
      ).rows,
    ).toEqual([{ n: 3 }]);
    // 核对任务对已删除的月份照常核对，结果仍是 ok。
    const reconciled = await withSystem(
      app.db,
      (tx) => reconcileTenantStatements(tx, f.tenant.id),
      snapshot,
    );
    expect(reconciled.statements.map((s) => [s.month, s.status])).toEqual([
      ['2026-08-01', 'ok'],
      ['2026-09-01', 'ok'],
    ]);
    // 重新生成不可用：服务层 409 与触发器兜底。
    const regenerate = await withAdmin(
      app.db,
      (tx) =>
        regenerateStatement(tx, f.tenant.id, '2026-08-01', {
          expectedVersion: 1,
          adminId: administrator,
        }).catch((error: unknown) => error),
      snapshot,
    );
    expect(regenerate).toBeInstanceOf(StatementError);
    expect(regenerate).toMatchObject({ code: 'STATEMENT_DETAILS_DELETED' });
    // 月份列表显示已删除、条数与操作人。
    const [august] = (
      await withAdmin(app.db, (tx) =>
        listCdrDeletionMonths(tx, { tenantId: f.tenant.id, year: 2026 }),
      )
    ).slice(7, 8);
    expect(august).toMatchObject({
      month: '2026-08',
      state: 'deleted',
      cdrCount: 3,
      deleted: { by: { id: administrator, name: '王敏' } },
    });
    expect(august!.deleted!.at).toBeInstanceOf(Date);
    // 已经删除的月份再删：拒绝，不再有任何变化。
    expect(
      await codeOf(deleteCdrMonths(app.db, input(f, { expectedCount: 0 }))),
    ).toEqual({
      code: 'CDR_MONTH_NOT_DELETABLE',
      month: '2026-08',
    });
  });

  it('a call that rang at the end of August and was answered in September goes with September', async () => {
    const f = await fixture();
    await deleteCdrMonths(
      app.db,
      input(f, { fromMonth: '2026-09', toMonth: '2026-09' }),
    );
    // 9 月的三条（含 8 月分区里的那一通）没了，8 月的三条还在。
    expect(await septemberCdrs(f.tenant.id)).toBe(0);
    expect(await augustCdrs(f.tenant.id)).toBe(3);
    expect(
      (
        await owner.pool.query(
          `select count(*)::int as n from only cdrs_2026_08 where call_uuid = $1`,
          [f.crossMonth],
        )
      ).rows,
    ).toEqual([{ n: 0 }]);
  });

  it('writes one cdr_delete audit per month with actor, time, tenant, month and count', async () => {
    const f = await fixture();
    const result = await deleteCdrMonths(
      app.db,
      input(f, { toMonth: '2026-09', expectedCount: 6 }),
    );
    expect(result.months.map((m) => [m.month, m.deleted])).toEqual([
      ['2026-08', 3],
      ['2026-09', 3],
    ]);
    const audits = (
      await owner.pool.query<{
        id: string;
        admin_id: string;
        tenant_id: string;
        target: string;
        created_at: Date;
        details: {
          actor: { id: string; name: string };
          target: { kind: string; id: string };
          content: Record<string, unknown> & { changes: unknown[] };
        };
        deleted_at: Date;
      }>(
        `select l.id, l.admin_id, l.tenant_id, l.target, l.created_at, l.details, s.details_deleted_at as deleted_at
         from operation_logs l join monthly_statements s on s.id::text = l.target
         where l.action = 'cdr_delete' and l.tenant_id = $1 order by s.month`,
        [f.tenant.id],
      )
    ).rows;
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => a.id)).toEqual(
      result.months.map((m) => m.auditId),
    );
    expect(audits[0]).toMatchObject({
      admin_id: administrator,
      tenant_id: f.tenant.id,
      details: {
        actor: { id: administrator, name: '王敏' },
        target: { kind: 'statement' },
        content: {
          month: '2026-08',
          deletedCount: 3,
          // 起点取 max(月初, 租户创建日)，终点取月末。
          range: { from: '2026-08-12', to: '2026-08-31' },
          confirmedCode: f.tenant.code,
          changes: [{ field: 'callCount', before: '3', after: '0' }],
        },
      },
    });
    expect(String(audits[0]!.details.content.summary)).toContain(
      `删除话单 ${f.tenant.code} 2026年8月 3 条`,
    );
    // 摘要写明原始 JSON 不随删除话单清除（决定 34）。
    expect(String(audits[0]!.details.content.summary)).toContain(
      '原始 JSON 不随删除话单清除',
    );
    expect(audits[1]).toMatchObject({
      details: {
        content: {
          month: '2026-09',
          range: { from: '2026-09-01', to: '2026-09-30' },
        },
      },
    });
    // 日志时间就是账单上记的删除时间；两个月各自一个事务，各一条。
    for (const audit of audits)
      expect(audit.created_at).toEqual(audit.deleted_at);
    expect(result.months.map((m) => m.statementId)).toEqual(
      audits.map((a) => a.target),
    );
  });

  it('flags the statement and removes the rows in one transaction', async () => {
    const f = await fixture();
    const name = `block_cdr_delete_audit_${randomUUID().replaceAll('-', '')}`;
    // 删除话单与置标志都成功之后，写日志失败：整个事务回滚。
    await owner.pool.query(`
      create function ${name}() returns trigger language plpgsql as $$
      begin raise exception 'audit blocked' using errcode = 'P0001'; end $$;
      create trigger ${name} before insert on operation_logs
        for each row when (new.action = 'cdr_delete') execute function ${name}();`);
    try {
      const error = await deleteCdrMonths(app.db, input(f)).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).cause ?? error)).toContain(
        'audit blocked',
      );
    } finally {
      await owner.pool.query(
        `drop trigger ${name} on operation_logs; drop function ${name}();`,
      );
    }
    expect(await augustCdrs(f.tenant.id)).toBe(3);
    expect(await flagged(f.tenant.id, '2026-08-01')).toEqual({
      details_deleted: false,
      details_deleted_count: null,
      details_deleted_by: null,
      has_time: false,
    });
    // 同样的请求在日志可写时成功：话单没了、标志置上，一起。
    await deleteCdrMonths(app.db, input(f));
    expect(await augustCdrs(f.tenant.id)).toBe(0);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      true,
    );
  });

  it('rejects an unknown operator without deleting anything', async () => {
    const f = await fixture();
    // 账单上记的操作人是外键：不存在的管理员在置标志时被拒绝，话单也一起保住。
    const error = await pgError(
      deleteCdrMonths(
        app.db,
        input(f, { actor: { id: randomUUID(), name: '谁' } }),
      ),
    );
    expect(error.code).toBe('23503');
    expect(await augustCdrs(f.tenant.id)).toBe(3);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      false,
    );
  });

  it('rejects a month with a charge not yet written', async () => {
    const f = await fixture();
    const callUuid = await chargedCall(owner, f.tenant.id, {
      answeredAt: '2026-08-28 10:00:00',
      ledger: false,
    });
    expect(
      await codeOf(deleteCdrMonths(app.db, input(f, { expectedCount: 4 }))),
    ).toEqual({ code: 'CDR_MONTH_NOT_DELETABLE', month: '2026-08' });
    expect(await augustCdrs(f.tenant.id)).toBe(4);
    // 补上流水以后账单落后于账本：核对（stale）之前不能删，重新生成并核对通过之后才能删。
    await withAdmin(owner.db, async (tx) => {
      await lockTenants(tx, [f.tenant.id]);
      await tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at, created_at)
        values (${f.tenant.id}::uuid, 'call_charge', -0.1, ${`call:${callUuid}`}, '2026-08-28 10:00:00+08', now())`);
    });
    await withSystem(
      app.db,
      (tx) => reconcileTenantStatements(tx, f.tenant.id),
      snapshot,
    );
    const [stale] = (
      await withAdmin(app.db, (tx) =>
        listCdrDeletionMonths(tx, { tenantId: f.tenant.id, year: 2026 }),
      )
    ).slice(7, 8);
    expect(stale).toMatchObject({
      state: 'blocked',
      blockedReasons: ['reconcile_not_ok'],
    });
    await withAdmin(
      app.db,
      (tx) =>
        regenerateStatement(tx, f.tenant.id, '2026-08-01', {
          expectedVersion: 1,
          adminId: administrator,
        }),
      snapshot,
    );
    await withSystem(
      app.db,
      (tx) => reconcileTenantStatements(tx, f.tenant.id),
      snapshot,
    );
    const result = await deleteCdrMonths(
      app.db,
      input(f, { expectedCount: 4 }),
    );
    expect(result).toMatchObject({ total: 4, failure: null });
    expect(await augustCdrs(f.tenant.id)).toBe(0);
  });

  it('rejects a month that is stale or inconsistent', async () => {
    for (const status of ['unchecked', 'stale', 'inconsistent'] as const) {
      const f = await fixture();
      await owner.pool.query(
        `update monthly_statements set reconcile_status = $2 where tenant_id = $1 and month = '2026-08-01'`,
        [f.tenant.id, status],
      );
      expect({
        status,
        ...(await codeOf(deleteCdrMonths(app.db, input(f)))),
      }).toEqual({
        status,
        code: 'CDR_MONTH_NOT_DELETABLE',
        month: '2026-08',
      });
      expect(await augustCdrs(f.tenant.id)).toBe(3);
    }
    // 账单生成后没有核对过的租户同样不能删。
    const unreconciled = await fixture({ reconcile: false });
    expect(await codeOf(deleteCdrMonths(app.db, input(unreconciled)))).toEqual({
      code: 'CDR_MONTH_NOT_DELETABLE',
      month: '2026-08',
    });
  });

  it('requires the exact tenant code and the previewed count', async () => {
    const f = await fixture();
    for (const tenantCode of [
      f.tenant.code.toLowerCase(),
      `${f.tenant.code} `,
      '',
      'OTHER',
    ])
      expect(
        await codeOf(deleteCdrMonths(app.db, input(f, { tenantCode }))),
      ).toEqual({ code: 'VALIDATION_ERROR', month: null });
    for (const expectedCount of [0, 2, 4])
      expect(
        await codeOf(deleteCdrMonths(app.db, input(f, { expectedCount }))),
      ).toEqual({ code: 'CDR_DELETE_COUNT_CHANGED', month: null });
    for (const [fromMonth, toMonth] of [
      ['2026-09', '2026-08'],
      ['2026-8', '2026-09'],
      ['2000-01', '2099-12'],
    ] as const)
      expect(
        (
          await codeOf(
            deleteCdrMonths(app.db, input(f, { fromMonth, toMonth })),
          )
        ).code,
      ).toBe('VALIDATION_ERROR');
    await expect(
      deleteCdrMonths(app.db, input(f, { tenantId: randomUUID() })),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    expect(await augustCdrs(f.tenant.id)).toBe(3);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      false,
    );
  });

  it('deleting a month without calls still records the deletion', async () => {
    const f = await fixture();
    await deleteCdrMonths(
      app.db,
      input(f, { toMonth: '2026-09', expectedCount: 6 }),
    );
    // 一个全新的、有账单而没有话单的月份。
    const empty = await statementTenant(owner, {
      createdAt: '2026-08-12 09:30:00',
    });
    for (const month of ['2026-08-01', '2026-09-01'])
      await withSystem(
        app.db,
        (tx) => generateStatement(tx, empty.id, month),
        snapshot,
      );
    await withSystem(
      app.db,
      (tx) => reconcileTenantStatements(tx, empty.id),
      snapshot,
    );
    const result = await deleteCdrMonths(app.db, {
      actor,
      tenantId: empty.id,
      fromMonth: '2026-08',
      toMonth: '2026-08',
      tenantCode: empty.code,
      expectedCount: 0,
    });
    expect(result.months).toMatchObject([{ month: '2026-08', deleted: 0 }]);
    expect((await flagged(empty.id, '2026-08-01')).details_deleted_count).toBe(
      0,
    );
  });
});

describe('并发', () => {
  it('deleting the same month twice affects it once', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      deleteCdrMonths(app.db, input(f)),
      deleteCdrMonths(app.db, input(f)),
      deleteCdrMonths(app.db, input(f)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected'))
      expect(r.reason).toMatchObject({ code: 'CDR_MONTH_NOT_DELETABLE' });
    expect(await augustCdrs(f.tenant.id)).toBe(0);
    expect(
      (
        await owner.pool.query(
          `select count(*)::int as n from operation_logs where action = 'cdr_delete' and tenant_id = $1`,
          [f.tenant.id],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });

  it('delete waits for an in-flight assignment', async () => {
    const f = await fixture();
    const locked = deferred();
    const release = deferred();
    // 正在进行的分配：持租户锁，已经写了一通尚未扣费的话单，还没提交。
    const inFlight = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [f.tenant.id]);
      await tx.execute(sql`insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
          billing_number, duration_seconds, billed_minutes, matched_prefix, country, rate, charge)
        values (${f.tenant.id}::uuid, ${randomUUID()}::uuid, '2026-08-28 09:59:55+08', '2026-08-28 10:00:00+08',
          '2026-08-28 10:01:01+08', '1', '2', '8613800138000', 61, 2, '86', '中国', 0.05, 0.1)`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const attempt = deleteCdrMonths(app.db, input(f)).catch((e: unknown) => e);
    const early = await Promise.race([
      attempt.then(() => 'done'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 300)),
    ]);
    expect(early).toBe('waiting');
    release.resolve();
    await inFlight;
    // 锁内重新检查：新进来的话单没有扣费流水，8 月不再可删。
    expect(await attempt).toMatchObject({
      code: 'CDR_MONTH_NOT_DELETABLE',
      month: '2026-08',
    });
    expect(await augustCdrs(f.tenant.id)).toBe(4);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      false,
    );
  });

  it('a call that arrives and is charged while the delete waits for the tenant lock stops the delete', async () => {
    const f = await fixture();
    const locked = deferred();
    const release = deferred();
    // 同一时刻到达并已扣费的话单（Worker 的入库加扣费）：持租户锁，写话单与流水，还没提交。
    const inFlight = adminTransaction(app.db, async (tx) => {
      await lockTenants(tx, [f.tenant.id]);
      const callUuid = randomUUID();
      await tx.execute(sql`insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
          billing_number, duration_seconds, billed_minutes, matched_prefix, country, rate, charge)
        values (${f.tenant.id}::uuid, ${callUuid}::uuid, '2026-08-28 09:59:55+08', '2026-08-28 10:00:00+08',
          '2026-08-28 10:01:01+08', '1', '2', '8613800138000', 61, 2, '86', '中国', 0.05, 0.1)`);
      await tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
        values (${f.tenant.id}::uuid, 'call_charge', -0.1, ${`call:${callUuid}`}, '2026-08-28 10:00:00+08')`);
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const attempt = deleteCdrMonths(app.db, input(f)).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 200));
    release.resolve();
    await inFlight;
    // 状态仍是可删（已扣费），但锁内重算的条数比预览多一条：拒绝，什么都不删。
    expect(await attempt).toMatchObject({
      code: 'CDR_DELETE_COUNT_CHANGED',
      month: '2026-08',
    });
    expect(await augustCdrs(f.tenant.id)).toBe(4);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      false,
    );
  });

  it('regeneration racing a deletion is rejected by the guard', async () => {
    const f = await fixture();
    const regenerating = await app.pool.connect();
    try {
      await regenerating.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await regenerating.query(`select set_config('app.scope', 'admin', true)`);
      // 重新生成先读到账单（标志还没置）。
      const { rows } = await regenerating.query<{ details_deleted: boolean }>(
        `select details_deleted from monthly_statements where tenant_id = $1 and month = '2026-08-01'`,
        [f.tenant.id],
      );
      expect(rows[0]!.details_deleted).toBe(false);
      // 删除话单在它之后提交。
      await deleteCdrMonths(app.db, input(f));
      // 重新生成再写头部：快照之后被改过的行不能更新，触发器兜底保证已删除的月份不会被改数字。
      const error = await pgError(
        regenerating.query(
          `update monthly_statements set calls = calls + 1, version = version + 1
           where tenant_id = $1 and month = '2026-08-01'`,
          [f.tenant.id],
        ),
      );
      expect(['40001', '23514']).toContain(error.code);
    } finally {
      await regenerating.query('ROLLBACK');
      regenerating.release();
    }
    // 不管哪个先到：账单头部数字没变，标志为真。
    expect(await flagged(f.tenant.id, '2026-08-01')).toMatchObject({
      details_deleted: true,
      details_deleted_count: 3,
    });
    expect(
      (
        await owner.pool.query(
          `select calls, version from monthly_statements where tenant_id = $1 and month = '2026-08-01'`,
          [f.tenant.id],
        )
      ).rows,
    ).toEqual([{ calls: 3, version: 1 }]);
  });

  it('keeps the months already deleted when a later month fails and retries only the rest', async () => {
    const f = await fixture();
    const name = `block_sept_delete_${randomUUID().replaceAll('-', '')}`;
    await owner.pool.query(`
      create function ${name}() returns trigger language plpgsql as $$
      begin
        if old.tenant_id = '${f.tenant.id}'::uuid and coalesce(old.answered_at, old.started_at) >= '2026-08-31 16:00+00' then
          raise exception 'storage failure' using errcode = 'XX000';
        end if;
        return old;
      end $$;
      create trigger ${name} before delete on cdrs for each row execute function ${name}();`);
    let result;
    try {
      result = await deleteCdrMonths(
        app.db,
        input(f, { toMonth: '2026-09', expectedCount: 6 }),
      );
    } finally {
      await owner.pool.query(
        `drop trigger ${name} on cdrs; drop function ${name}();`,
      );
    }
    // 8 月已完成并保留；9 月整个事务回滚，原样在；结果列出剩余月份。
    expect(result).toMatchObject({
      total: 3,
      months: [{ month: '2026-08', deleted: 3 }],
      remaining: ['2026-09'],
      failure: { month: '2026-09', code: 'INTERNAL' },
    });
    expect(await augustCdrs(f.tenant.id)).toBe(0);
    expect(await septemberCdrs(f.tenant.id)).toBe(3);
    expect((await flagged(f.tenant.id, '2026-08-01')).details_deleted).toBe(
      true,
    );
    expect((await flagged(f.tenant.id, '2026-09-01')).details_deleted).toBe(
      false,
    );
    // 原范围再提交会因 8 月已删除而整体拒绝；只重试剩余的月份就成功。
    expect(
      await codeOf(
        deleteCdrMonths(
          app.db,
          input(f, { toMonth: '2026-09', expectedCount: 3 }),
        ),
      ),
    ).toEqual({ code: 'CDR_MONTH_NOT_DELETABLE', month: '2026-08' });
    const retry = await deleteCdrMonths(
      app.db,
      input(f, { fromMonth: '2026-09', toMonth: '2026-09', expectedCount: 3 }),
    );
    expect(retry).toMatchObject({ total: 3, failure: null });
    expect(await septemberCdrs(f.tenant.id)).toBe(0);
  });
});

describe('删除之后', () => {
  it('a re-pushed deleted call is a duplicate', async () => {
    const f = await fixture();
    await deleteCdrMonths(app.db, input(f));
    // 登记保留：HTTP 入库先查登记，已登记就判重复，不会再写 cdrs，也就不会再扣费。
    const registered = await withSystem(app.db, (tx) =>
      tx.execute<{ call_uuid: string }>(
        sql`select call_uuid::text from call_uuids where call_uuid = ${f.august[0]!}::uuid`,
      ),
    );
    expect(registered.rows).toHaveLength(1);
    // 即使绕过查询硬写一条同 UUID 的话单，声明入库的事务也不会认领这个登记。
    const error = await pgError(
      withSystem(app.db, async (tx) => {
        await tx.execute(
          sql`select set_config('app.cdr_ingest', 'true', true)`,
        );
        await lockTenants(tx, [f.tenant.id]);
        await tx.execute(sql`insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
            billing_number, duration_seconds, billed_minutes, matched_prefix, country, rate, charge)
          values (${f.tenant.id}::uuid, ${f.august[0]!}::uuid, '2026-08-15 09:59:55+08', '2026-08-15 10:00:00+08',
            '2026-08-15 10:01:01+08', '1', '2', '8613800138000', 61, 2, '86', '中国', 0.05, 0.1)`);
      }),
    );
    expect(error).toMatchObject({
      code: '23505',
      constraint: 'call_uuids_pkey',
    });
    expect(await augustCdrs(f.tenant.id)).toBe(0);
    expect(
      (
        await owner.pool.query(
          `select count(*)::int as n from ledger_entries where tenant_id = $1 and idempotency_key = $2`,
          [f.tenant.id, `call:${f.august[0]}`],
        )
      ).rows,
    ).toEqual([{ n: 1 }]);
  });
});
