import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  adminId,
  connections,
  createTenant,
  pgError,
  tenantId,
} from '../test/support.js';
import { lockTenants, withAdmin, withSystem, withTenant } from './client.js';
import { currentMonthSeedMonth } from './seed-calls.js';

const { app, owner } = connections();

// 播种月 1 日凌晨的 20 通话单（时钟太靠近 1 日凌晨时不播种）。
const currentMonthCalls = currentMonthSeedMonth(new Date()) ? 20 : 0;

const tenantsOf = (rows: Record<string, unknown>[]) =>
  [...new Set(rows.map((r) => r.code))].sort();

describe('RLS 租户隔离', () => {
  it('以 ABC001 身份 SELECT * FROM cdrs（不写租户条件）只返回 ABC001 的话单', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const { rows } = await withTenant(app.db, abc001, (tx) =>
      tx.execute(
        sql`select cdrs.*, tenants.code from cdrs join tenants on tenants.id = cdrs.tenant_id order by started_at`,
      ),
    );
    // 8、9 月逐通话单 22,446 条已接通，加上 1 条未接通示例话单（阶段 7 决定 20），以及播种月的 20 通。
    expect(rows).toHaveLength(22447 + currentMonthCalls);
    expect(tenantsOf(rows)).toEqual(['ABC001']);
    expect(
      rows
        .filter((r) => String(r.call_uuid).startsWith('a0000001-'))
        .map((r) => [r.code, r.callee, r.billing_number, r.charge]),
    ).toEqual([
      ['ABC001', '+447700900123', '447700900123', '0.18'],
      ['ABC001', '+18765550100', '18765550100', '0.25'],
      ['ABC001', '13800138000', '8613800138000', '0'],
    ]);
  });

  it('以 GZT007 身份看到的是 GZT007 自己的话单与流水', async () => {
    const gzt007 = await tenantId(app, 'GZT007');
    const result = await withTenant(app.db, gzt007, async (tx) => ({
      cdrs: tenantsOf(
        (
          await tx.execute(
            sql`select code from cdrs join tenants on tenants.id = cdrs.tenant_id`,
          )
        ).rows,
      ),
      ledger: tenantsOf(
        (
          await tx.execute(
            sql`select code from ledger_entries join tenants on tenants.id = ledger_entries.tenant_id`,
          )
        ).rows,
      ),
      tenants: tenantsOf(
        (await tx.execute(sql`select code from tenants`)).rows,
      ),
      cdrCount: (await tx.execute(sql`select count(*)::int as n from cdrs`))
        .rows,
    }));
    expect(result).toEqual({
      cdrs: ['GZT007'],
      ledger: ['GZT007'],
      tenants: ['GZT007'],
      cdrCount: [{ n: 2 }],
    });
  });

  it('管理员身份可见全部租户的话单', async () => {
    const { rows } = await withAdmin(app.db, (tx) =>
      tx.execute(
        sql`select code from cdrs join tenants on tenants.id = cdrs.tenant_id where code in ('ABC001', 'GZT007')`,
      ),
    );
    expect([rows.length, tenantsOf(rows)]).toEqual([
      22449 + currentMonthCalls,
      ['ABC001', 'GZT007'],
    ]);
  });

  it('未声明身份时什么都看不到', async () => {
    const { rows } = await app.pool.query(
      `SELECT (SELECT count(*) FROM cdrs)::int AS cdrs, (SELECT count(*) FROM tenants)::int AS tenants,
              (SELECT count(*) FROM ledger_entries)::int AS ledger`,
    );
    expect(rows).toEqual([{ cdrs: 0, tenants: 0, ledger: 0 }]);
  });

  it('租户身份看不到仅限管理员的表', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const { rows } = await withTenant(app.db, abc001, (tx) =>
      tx.execute(
        sql`select (select count(*) from unassigned_cdrs)::int as unassigned, (select count(*) from admins)::int as admins`,
      ),
    );
    expect(rows).toEqual([{ unassigned: 0, admins: 0 }]);
  });

  it('租户身份不能写入其他租户的行', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const gzt007 = await tenantId(app, 'GZT007');
    const error = await pgError(
      withTenant(app.db, abc001, async (tx) => {
        await lockTenants(tx, [gzt007]);
        await tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key)
                             values (${gzt007}, 'call_charge', -1, 'call:cross-tenant')`);
      }),
    );
    expect(error).toMatchObject({
      code: '42501',
      message: `当前身份不能锁租户 ${gzt007}`,
    });
  });

  it('租户身份不能给自己充值：冒用管理员编号插入充值流水被拒绝，余额不变', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const error = await pgError(
      withTenant(app.db, tenant.id, async (tx) => {
        await lockTenants(tx, [tenant.id]);
        await tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, created_by, idempotency_key)
                             values (${tenant.id}, 'recharge', 1000, ${admin}, 'recharge:self')`);
      }),
    );
    const { rows } = await withTenant(app.db, tenant.id, (tx) =>
      tx.execute(
        sql`select (select count(*)::int from ledger_entries) as entries, balance::text from tenant_balances`,
      ),
    );
    expect({ error, rows }).toMatchObject({
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy for table "ledger_entries"',
      },
      rows: [{ entries: 0, balance: '0' }],
    });
  });

  it('租户身份不能修改自己的透支额度', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await pgError(
      withTenant(app.db, tenant.id, (tx) =>
        tx.execute(sql`update tenants set overdraft_limit = 999999`),
      ),
    );
    const { rows } = await withTenant(app.db, tenant.id, (tx) =>
      tx.execute(sql`select overdraft_limit::text from tenants`),
    );
    expect({ error, rows }).toMatchObject({
      error: {
        code: '42501',
        message:
          'new row violates row-level security policy for table "tenants"',
      },
      rows: [{ overdraft_limit: '100.00' }],
    });
  });

  it('租户身份删除自己的话单：0 行受影响，话单仍在', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withSystem(app.db, (tx) =>
      tx.execute(sql`insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee, billing_number)
                     values (${tenant.id}, ${randomUUID()}, '2026-10-12T10:00:00+08:00',
                             '2026-10-12T10:00:30+08:00', '075586001234', '8613800138000', '8613800138000')`),
    );
    const result = await withTenant(app.db, tenant.id, async (tx) => ({
      deleted: (await tx.execute(sql`delete from cdrs`)).rowCount,
      remaining: (await tx.execute(sql`select count(*)::int as n from cdrs`))
        .rows,
    }));
    expect(result).toEqual({ deleted: 0, remaining: [{ n: 1 }] });
  });

  it('系统身份（Worker）可以写入任一租户的扣费', async () => {
    const tenant = await createTenant(app, 'CNY');
    await withSystem(app.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key)
                           values (${tenant.id}, 'call_charge', -0.18, 'call:system-scope')`);
    });
    const { rows } = await withTenant(app.db, tenant.id, (tx) =>
      tx.execute(sql`select balance::text from tenant_balances`),
    );
    expect(rows).toEqual([{ balance: '-0.18' }]);
  });

  it('建分区只允许管理员或系统身份：租户身份与未声明身份调用被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const call = sql`select cdr_ensure_partitions('2026-10-12T00:00:00+08:00')`;
    const errors = [
      await pgError(withTenant(app.db, tenant.id, (tx) => tx.execute(call))),
      await pgError(
        app.pool.query(
          `SELECT cdr_ensure_partitions('2026-10-12T00:00:00+08:00')`,
        ),
      ),
    ];
    const { rows } = await withSystem(app.db, (tx) => tx.execute(call));
    expect({ errors, created: rows.length }).toMatchObject({
      errors: [
        { code: '42501', message: '建分区只允许管理员或系统身份' },
        { code: '42501', message: '建分区只允许管理员或系统身份' },
      ],
      created: 4,
    });
  });

  it('应用角色不能绕过父表直接读分区', async () => {
    const error = await pgError(app.pool.query('SELECT * FROM cdrs_2026_09'));
    expect(error).toMatchObject({
      code: '42501',
      message: 'permission denied for table cdrs_2026_09',
    });
  });
});

describe('月账单明细表（阶段 7）', () => {
  const detailTables = [
    'monthly_statement_countries',
    'monthly_statement_days',
  ] as const;

  it('statement detail tables show a tenant only its own rows and reject writes', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const gzt007 = await tenantId(app, 'GZT007');
    for (const [self, other] of [
      [abc001, gzt007],
      [gzt007, abc001],
    ] as const) {
      const visible = await withTenant(app.db, self, async (tx) => ({
        headers: (
          await tx.execute(
            sql`select distinct tenant_id from monthly_statements`,
          )
        ).rows,
        countries: (
          await tx.execute(
            sql`select distinct tenant_id from monthly_statement_countries`,
          )
        ).rows,
        days: (
          await tx.execute(
            sql`select distinct tenant_id from monthly_statement_days`,
          )
        ).rows,
      }));
      expect(visible).toEqual({
        headers: [{ tenant_id: self }],
        countries: [{ tenant_id: self }],
        days: [{ tenant_id: self }],
      });
      // 即使点名对方的账单也读不到。
      const peeking = await withTenant(app.db, self, (tx) =>
        tx.execute(
          sql`select count(*)::int as n from monthly_statement_days where tenant_id = ${other}::uuid`,
        ),
      );
      expect(peeking.rows).toEqual([{ n: 0 }]);
    }

    const tenantWrites: Record<
      string,
      { sql: ReturnType<typeof sql>; code: string }
    > = {
      'insert into countries': {
        sql: sql`insert into monthly_statement_countries (statement_id, tenant_id, version, country, calls, minutes, charge)
                 select id, tenant_id, 9, 'x', 0, 0, 0 from monthly_statements where tenant_id = ${abc001}::uuid limit 1`,
        code: '42501',
      },
      'insert into days': {
        sql: sql`insert into monthly_statement_days (statement_id, tenant_id, version, day, calls, minutes, charge)
                 select id, tenant_id, 9, '2026-09-01', 0, 0, 0 from monthly_statements where tenant_id = ${abc001}::uuid limit 1`,
        code: '42501',
      },
      'update countries': {
        sql: sql`update monthly_statement_countries set calls = 0`,
        code: '42501',
      },
      'delete days': {
        sql: sql`delete from monthly_statement_days`,
        code: '42501',
      },
      'update header': {
        sql: sql`update monthly_statements set reconcile_status = 'ok'`,
        code: '42501',
      },
      'insert header': {
        sql: sql`insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift, adjustment, call_charges, closing_balance, call_minutes)
                 values (${abc001}::uuid, '2030-01-01', 0, 0, 0, 0, 0, 0, 0)`,
        code: '42501',
      },
    };
    for (const [label, write] of Object.entries(tenantWrites)) {
      const error = await pgError(
        withTenant(app.db, abc001, (tx) => tx.execute(write.sql)),
      );
      expect({ label, code: error.code }).toEqual({ label, code: write.code });
    }
    const { rows } = await app.pool.query(
      `SELECT (SELECT count(*) FROM monthly_statements)::int AS headers,
              (SELECT count(*) FROM monthly_statement_countries)::int AS countries,
              (SELECT count(*) FROM monthly_statement_days)::int AS days`,
    );
    expect(rows).toEqual([{ headers: 0, countries: 0, days: 0 }]);
  });

  it('statement detail rows cannot be updated or deleted', async () => {
    for (const table of detailTables) {
      const messages = [];
      for (const statement of [
        `UPDATE ${table} SET calls = calls`,
        `DELETE FROM ${table}`,
        `TRUNCATE ${table}`,
      ]) {
        messages.push((await pgError(owner.pool.query(statement))).message);
      }
      expect(messages).toEqual([
        `${table} 只能新增，禁止 UPDATE`,
        `${table} 只能新增，禁止 DELETE`,
        `${table} 只能新增，禁止 TRUNCATE`,
      ]);
      // 应用角色根本没有这些权限。
      for (const statement of [
        sql.raw(`update ${table} set calls = calls`),
        sql.raw(`delete from ${table}`),
      ]) {
        expect(
          await pgError(withAdmin(app.db, (tx) => tx.execute(statement))),
        ).toMatchObject({
          code: '42501',
          message: `permission denied for table ${table}`,
        });
      }
    }
    const { rows } = await owner.pool.query(
      `SELECT count(*)::int AS n FROM monthly_statement_days d JOIN tenants t ON t.id = d.tenant_id WHERE t.code = 'ABC001'`,
    );
    expect(rows).toEqual([{ n: 49 }]);
  });

  it('the operator roles can append detail rows but the version must match a statement of the same tenant', async () => {
    const abc001 = await tenantId(app, 'ABC001');
    const gzt007 = await tenantId(app, 'GZT007');
    // 复合外键：明细的租户必须与账单一致。
    const error = await pgError(
      withSystem(app.db, (tx) =>
        tx.execute(sql`insert into monthly_statement_countries (statement_id, tenant_id, version, country, calls, minutes, charge)
          select id, ${gzt007}::uuid, 9, 'x', 0, 0, 0 from monthly_statements where tenant_id = ${abc001}::uuid limit 1`),
      ),
    );
    expect(error).toMatchObject({
      code: '23503',
      constraint: 'monthly_statement_countries_statement_id_tenant_id_fkey',
    });
  });
});

describe('话单运维表（阶段 8）', () => {
  /** 为每张表备一行：未归属话单有种子，批次与操作日志由测试写入（owner）。 */
  async function ensureOperationRows() {
    const admin = await adminId(owner);
    const tenant = await createTenant(app, 'CNY');
    const auditId = randomUUID();
    await owner.pool.query(
      `insert into operation_logs (admin_id, tenant_id, action, target) values ($1, $2, 'rls_probe', 'x')`,
      [admin, tenant.id],
    );
    await owner.pool.query(
      `insert into unassigned_assignments (tenant_id, idempotency_key, requested_by, request_digest, assigned_count,
         no_rate_count, blocked_count, charge_total, balance_before, balance_after, affected_months, audit_id)
       values ($1, $2, $3, 'digest', 0, 0, 0, 0, 0, 0, '{}', $4)`,
      [tenant.id, `rls:${auditId}`, admin, auditId],
    );
    return { admin, tenant };
  }

  it('new staff-only tables hide their rows from tenants', async () => {
    const { admin, tenant } = await ensureOperationRows();
    const abc001 = await tenantId(app, 'ABC001');
    for (const scoped of [abc001, tenant.id]) {
      const { rows } = await withTenant(app.db, scoped, (tx) =>
        tx.execute(
          sql`select (select count(*) from unassigned_cdrs)::int as unassigned,
                     (select count(*) from unassigned_assignments)::int as assignments,
                     (select count(*) from operation_logs)::int as logs`,
        ),
      );
      expect(rows).toEqual([{ unassigned: 0, assignments: 0, logs: 0 }]);
    }
    // 管理员看得到：对照组，证明上面的 0 是策略而不是没有数据。
    const { rows: seen } = await withAdmin(app.db, (tx) =>
      tx.execute(
        sql`select (select count(*) from unassigned_cdrs)::int > 0 as unassigned,
                   (select count(*) from unassigned_assignments)::int > 0 as assignments,
                   (select count(*) from operation_logs)::int > 0 as logs`,
      ),
    );
    expect(seen).toEqual([{ unassigned: true, assignments: true, logs: true }]);

    const writes: Record<
      string,
      { sql: ReturnType<typeof sql>; code: string }
    > = {
      'insert unassigned_cdrs': {
        sql: sql`insert into unassigned_cdrs (call_uuid, reason, started_at, ended_at, caller, callee, billing_number)
                 values (${randomUUID()}, '租户不存在', now(), now(), '1', '2', '8613800138000')`,
        code: '42501',
      },
      'insert unassigned_assignments': {
        sql: sql`insert into unassigned_assignments (tenant_id, idempotency_key, requested_by, request_digest, assigned_count,
                   no_rate_count, blocked_count, charge_total, balance_before, balance_after, affected_months, audit_id)
                 values (${abc001}::uuid, 'tenant-write', ${admin}::uuid, 'd', 0, 0, 0, 0, 0, 0, '{}', ${randomUUID()}::uuid)`,
        code: '42501',
      },
      'insert operation_logs': {
        sql: sql`insert into operation_logs (admin_id, action) values (${admin}::uuid, 'tenant-write')`,
        code: '42501',
      },
      // 应用角色没有这些权限，先于策略被拒。
      'update unassigned_assignments': {
        sql: sql`update unassigned_assignments set assigned_count = 1`,
        code: '42501',
      },
      'delete unassigned_assignments': {
        sql: sql`delete from unassigned_assignments`,
        code: '42501',
      },
      'delete unassigned_cdrs': {
        sql: sql`delete from unassigned_cdrs`,
        code: '42501',
      },
      'update operation_logs': {
        sql: sql`update operation_logs set action = 'x'`,
        code: '42501',
      },
      'delete operation_logs': {
        sql: sql`delete from operation_logs`,
        code: '42501',
      },
    };
    for (const [label, write] of Object.entries(writes)) {
      const error = await pgError(
        withTenant(app.db, abc001, (tx) => tx.execute(write.sql)),
      );
      expect({ label, code: error.code }).toEqual({ label, code: write.code });
    }
    // 有 UPDATE 权限的 unassigned_cdrs：策略让租户一行都改不到。
    const updated = await withTenant(app.db, abc001, (tx) =>
      tx.execute(sql`update unassigned_cdrs set reason = '被租户改过'`),
    );
    expect(updated.rowCount).toBe(0);
    const { rows: untouched } = await owner.pool.query(
      `select count(*)::int as n from unassigned_cdrs where reason = '被租户改过'`,
    );
    expect(untouched).toEqual([{ n: 0 }]);
  });

  it('unassigned_assignments stays append-only', async () => {
    await ensureOperationRows();
    const messages = [];
    for (const statement of [
      `UPDATE unassigned_assignments SET assigned_count = assigned_count`,
      `DELETE FROM unassigned_assignments`,
    ])
      messages.push((await pgError(owner.pool.query(statement))).message);
    expect(messages).toEqual([
      'unassigned_assignments 只能新增，禁止 UPDATE',
      'unassigned_assignments 只能新增，禁止 DELETE',
    ]);
    // unassigned_cdrs 引用它，PostgreSQL 在触发器之前就拒绝了 TRUNCATE；触发器仍在，是第二道防线。
    expect(
      (await pgError(owner.pool.query('TRUNCATE unassigned_assignments')))
        .message,
    ).toMatch(/只能新增，禁止 TRUNCATE|cannot truncate a table referenced/);
    const { rows } = await owner.pool.query(
      `select tgname from pg_trigger where tgrelid = 'unassigned_assignments'::regclass and not tgisinternal order by 1`,
    );
    expect(rows).toEqual([
      { tgname: 'unassigned_assignments_append_only' },
      { tgname: 'unassigned_assignments_no_truncate' },
    ]);
  });

  it('operation_logs stays append-only with a nullable actor', async () => {
    const admin = await adminId(owner);
    const insert = (adminValue: string | null, label: string | null) =>
      owner.pool.query(
        `insert into operation_logs (admin_id, actor_label, action, target) values ($1, $2, 'actor_probe', 'x') returning id`,
        [adminValue, label],
      );
    // 恰有其一：管理员，或没有管理员的事件来源标签。
    const label = `cli:auth:bootstrap@probe/${randomUUID().slice(0, 8)}`;
    expect((await insert(admin, null)).rowCount).toBe(1);
    expect((await insert(null, label)).rowCount).toBe(1);
    for (const [adminValue, actorLabel] of [
      [null, null],
      [admin, label],
      [null, ''],
      [null, '   '],
    ] as const)
      expect(
        await pgError(insert(adminValue, actorLabel)),
        `${adminValue} / ${actorLabel}`,
      ).toMatchObject({ code: '23514' });
    // 带标签的行同样只增。
    const messages = [];
    for (const statement of [
      `UPDATE operation_logs SET actor_label = 'x' WHERE action = 'actor_probe'`,
      `DELETE FROM operation_logs WHERE action = 'actor_probe'`,
      `TRUNCATE operation_logs`,
    ])
      messages.push((await pgError(owner.pool.query(statement))).message);
    expect(messages).toEqual([
      'operation_logs 只能新增，禁止 UPDATE',
      'operation_logs 只能新增，禁止 DELETE',
      'operation_logs 只能新增，禁止 TRUNCATE',
    ]);
    // 管理员身份可以写没有管理员的事件；系统身份与租户身份都不行。
    await withAdmin(app.db, (tx) =>
      tx.execute(
        sql`insert into operation_logs (actor_label, action, target) values (${label}, 'actor_probe', 'admin-scope')`,
      ),
    );
    expect(
      (
        await pgError(
          withSystem(app.db, (tx) =>
            tx.execute(
              sql`insert into operation_logs (actor_label, action, target) values (${label}, 'actor_probe', 'system-scope')`,
            ),
          ),
        )
      ).code,
    ).toBe('42501');
  });
});
