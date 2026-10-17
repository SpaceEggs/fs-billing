import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminId,
  connections,
  createTenant,
  pgError,
} from '../test/support.js';

const { app, owner } = connections();

/** 在 owner 事务里切换到审计角色执行一条语句，结束时回滚。 */
async function asAuditor<T extends object>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const client = await owner.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE fs_billing_audit');
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

type AuditRow = {
  id: string;
  created_at: Date;
  admin_id: string;
  admin_email: string;
  admin_name: string;
  tenant_code: string | null;
  action: string;
  target: string;
  details: unknown;
};

const query = (
  tenant: string | null,
  action: string | null,
  from: string | null,
  to: string | null,
) =>
  asAuditor<AuditRow>('SELECT * FROM audit_operation_logs($1, $2, $3, $4)', [
    tenant,
    action,
    from,
    to,
  ]);

const probe = `audit_probe_${randomUUID()}`;
const r1 = randomUUID();
const r2 = randomUUID();
let admin: string;
let tenantA: { id: string; code: string };
let tenantB: { id: string; code: string };

beforeAll(async () => {
  admin = await adminId(owner);
  tenantA = await createTenant(app, 'CNY');
  tenantB = await createTenant(app, 'USD');
  await owner.pool.query(
    `INSERT INTO operation_logs (id, admin_id, tenant_id, action, target, details, created_at) VALUES
       ($5, $1, $2, $4, 'r1', '{"n":1}', '2001-01-01T00:00:00Z'),
       ($6, $1, $2, 'other_action', 'r2', '{"n":2}', '2001-01-02T00:00:00Z'),
       (DEFAULT, $1, $3, $4, 'r3', '{"n":3}', '2001-01-03T00:00:00Z'),
       (DEFAULT, $1, NULL, $4, 'r4', '{"n":4}', '2001-01-04T00:00:00Z')`,
    [admin, tenantA.id, tenantB.id, probe, r1, r2],
  );
});

describe('audit_operation_logs', () => {
  it('filters by case-insensitive tenant code and returns the full row newest first', async () => {
    const rows = await query(tenantA.code.toLowerCase(), null, null, null);
    expect(rows).toEqual([
      {
        id: r2,
        created_at: new Date('2001-01-02T00:00:00Z'),
        admin_id: admin,
        admin_email: 'wangmin@example.com',
        admin_name: '王敏',
        tenant_code: tenantA.code,
        action: 'other_action',
        target: 'r2',
        details: { n: 2 },
      },
      {
        id: r1,
        created_at: new Date('2001-01-01T00:00:00Z'),
        admin_id: admin,
        admin_email: 'wangmin@example.com',
        admin_name: '王敏',
        tenant_code: tenantA.code,
        action: probe,
        target: 'r1',
        details: { n: 1 },
      },
    ]);
  });

  it('filters by exact action, keeping logs without a tenant', async () => {
    const rows = await query(null, probe, null, null);
    expect(rows.map((row) => [row.target, row.tenant_code])).toEqual([
      ['r4', null],
      ['r3', tenantB.code],
      ['r1', tenantA.code],
    ]);
  });

  it('time window includes p_from and excludes p_to', async () => {
    const rows = await query(
      null,
      null,
      '2001-01-02T00:00:00Z',
      '2001-01-04T00:00:00Z',
    );
    expect(rows.map((row) => row.target)).toEqual(['r3', 'r2']);
  });

  it('combines tenant, action and time filters', async () => {
    const rows = await query(
      tenantA.code,
      probe,
      '2001-01-01T00:00:00Z',
      '2001-02-01T00:00:00Z',
    );
    expect(rows.map((row) => row.target)).toEqual(['r1']);
  });

  it.each(['operation_logs', 'tenants', 'ledger_entries'])(
    'audit role cannot select, insert, update or delete %s',
    async (table) => {
      for (const statement of [
        `SELECT 1 FROM ${table} LIMIT 1`,
        `INSERT INTO ${table} DEFAULT VALUES`,
        `UPDATE ${table} SET id = id`,
        `DELETE FROM ${table}`,
      ])
        expect(await pgError(asAuditor(statement)), statement).toMatchObject({
          code: '42501',
        });
    },
  );

  it('application role cannot execute the audit query', async () => {
    expect(
      await pgError(app.pool.query('SELECT * FROM audit_operation_logs()')),
    ).toMatchObject({ code: '42501' });
  });

  it('audit role is a non-login, non-superuser, non-BYPASSRLS group role', async () => {
    const { rows } = await owner.pool.query(
      "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'fs_billing_audit'",
    );
    expect(rows).toEqual([
      { rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });
});
