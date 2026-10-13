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
import { withAdmin, withSystem, withTenant } from './client.js';

const { app, owner } = connections();

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
    expect(rows.map((r) => [r.code, r.callee, r.charge])).toEqual([
      ['ABC001', '447700900123', '0.18'],
      ['ABC001', '18765550100', '0.25'],
      ['ABC001', '8613800138000', '0'],
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
    expect([rows.length, tenantsOf(rows)]).toEqual([5, ['ABC001', 'GZT007']]);
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
      withTenant(app.db, abc001, (tx) =>
        tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key)
                       values (${gzt007}, 'call_charge', -1, 'call:cross-tenant')`),
      ),
    );
    expect(error).toMatchObject({
      code: '42501',
      message:
        'new row violates row-level security policy for table "ledger_entries"',
    });
  });

  it('租户身份不能给自己充值：冒用管理员编号插入充值流水被拒绝，余额不变', async () => {
    const tenant = await createTenant(app, 'CNY');
    const admin = await adminId(owner);
    const error = await pgError(
      withTenant(app.db, tenant.id, (tx) =>
        tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, created_by, idempotency_key)
                       values (${tenant.id}, 'recharge', 1000, ${admin}, 'recharge:self')`),
      ),
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
      tx.execute(sql`insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee)
                     values (${tenant.id}, ${randomUUID()}, '2026-10-12T10:00:00+08:00',
                             '2026-10-12T10:00:30+08:00', '075586001234', '8613800138000')`),
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
    await withSystem(app.db, (tx) =>
      tx.execute(sql`insert into ledger_entries (tenant_id, kind, amount, idempotency_key)
                     values (${tenant.id}, 'call_charge', -0.18, 'call:system-scope')`),
    );
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
