import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminId,
  connections,
  createTenant,
  pgError,
} from '../test/support.js';

const { app, owner } = connections();

/** 在 owner 事务里执行，结束时回滚。 */
async function rolledBack<T>(fn: (client: PoolClient) => Promise<T>) {
  const client = await owner.pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

const asAuditor = <T extends object>(text: string, values: unknown[] = []) =>
  rolledBack(async (client) => {
    await client.query('SET LOCAL ROLE fs_billing_audit');
    return (await client.query<T>(text, values)).rows;
  });

const violations = async (client: PoolClient) =>
  (
    await client.query<{ line: string }>(
      'SELECT line FROM audit_role_violations() line',
    )
  ).rows.map((row) => row.line);

const migration = readFile(
  new URL('../migrations/0014_audit_reader.sql', import.meta.url),
  'utf8',
);
const dropAuditFunctions = `DROP FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz);
  DROP FUNCTION audit_role_violations()`;
const publicAuthInsert = `GRANT USAGE ON SCHEMA auth TO PUBLIC;
  GRANT EXECUTE ON FUNCTION auth.insert_user(text, text, text) TO PUBLIC`;
const defaultTableUpdate =
  'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT UPDATE ON TABLES TO fs_billing_audit';
const auditQueryGrantOption =
  'GRANT EXECUTE ON FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz) TO fs_billing_audit WITH GRANT OPTION';
const auditQueryGrantOptionLine =
  '函数 public.audit_operation_logs(text,text,timestamp with time zone,timestamp with time zone)：EXECUTE WITH GRANT OPTION';

type AuditRow = {
  id: string;
  created_at: Date;
  admin_id: string | null;
  admin_email: string | null;
  admin_name: string | null;
  tenant_code: string | null;
  action: string;
  target: string;
  details: unknown;
  actor_label: string | null;
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
        actor_label: null,
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
        actor_label: null,
      },
    ]);
  });

  it('returns events that have no administrator with their actor label (nullable actor, LEFT JOIN)', async () => {
    const label = `cli:auth:bootstrap@probe-${randomUUID()}/ops`;
    await owner.pool.query(
      `INSERT INTO operation_logs (admin_id, actor_label, tenant_id, action, target, details, created_at)
       VALUES (NULL, $1, $2, $3, 'r5', '{"n":5}', '2001-01-05T00:00:00Z')`,
      [label, tenantA.id, `${probe}_label`],
    );
    const rows = await query(null, `${probe}_label`, null, null);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      ...rows[0]!,
      created_at: new Date('2001-01-05T00:00:00Z'),
      admin_id: null,
      admin_email: null,
      admin_name: null,
      tenant_code: tenantA.code,
      action: `${probe}_label`,
      target: 'r5',
      details: { n: 5 },
      actor_label: label,
    });
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

  it.each([
    [
      'membership',
      'CREATE ROLE audit_probe_group; GRANT audit_probe_group TO fs_billing_audit',
      ['是角色 audit_probe_group 的成员'],
    ],
    [
      'table UPDATE',
      'GRANT UPDATE ON tenants TO fs_billing_audit',
      ['表 public.tenants：UPDATE'],
    ],
    [
      'table MAINTAIN',
      'GRANT MAINTAIN ON tenants TO fs_billing_audit',
      ['表 public.tenants：MAINTAIN'],
    ],
    [
      'column UPDATE',
      'GRANT UPDATE (name) ON tenants TO fs_billing_audit',
      ['列 public.tenants.name：UPDATE'],
    ],
    [
      'sequence USAGE',
      'CREATE SEQUENCE review_seq; GRANT USAGE ON SEQUENCE review_seq TO fs_billing_audit',
      ['序列 public.review_seq：USAGE'],
    ],
    [
      'PUBLIC EXECUTE on an auth writer',
      publicAuthInsert,
      ['schema auth：USAGE', '函数 auth.insert_user(text,text,text)：EXECUTE'],
    ],
    [
      'default table privilege',
      defaultTableUpdate,
      [
        '默认权限：fs_billing 在 schema public 新建的表授予 fs_billing_audit UPDATE',
      ],
    ],
    [
      'global default table privilege',
      'ALTER DEFAULT PRIVILEGES GRANT UPDATE ON TABLES TO fs_billing_audit',
      [
        '默认权限：fs_billing 在 所有 schema 新建的表授予 fs_billing_audit UPDATE',
      ],
    ],
    [
      'EXECUTE WITH GRANT OPTION on the audit query',
      auditQueryGrantOption,
      [auditQueryGrantOptionLine],
    ],
    [
      'USAGE WITH GRANT OPTION on schema public',
      'GRANT USAGE ON SCHEMA public TO fs_billing_audit WITH GRANT OPTION',
      ['schema public：USAGE WITH GRANT OPTION'],
    ],
    [
      'schema CREATE',
      'GRANT CREATE ON SCHEMA public TO fs_billing_audit',
      ['schema public：CREATE'],
    ],
    [
      'LOGIN attribute',
      'ALTER ROLE fs_billing_audit LOGIN',
      ['角色属性：LOGIN'],
    ],
  ])('audit_role_violations reports %s', async (_, dirty, expected) => {
    expect(
      await rolledBack(async (client) => {
        await client.query(dirty);
        return violations(client);
      }),
    ).toEqual(expected);
  });

  it('audit_role_violations is empty for the migrated role', async () => {
    expect(await rolledBack(violations)).toEqual([]);
  });

  it('audit_role_violations ignores default privileges in unrelated schemas', async () => {
    expect(
      await rolledBack(async (client) => {
        await client.query(`CREATE SCHEMA audit_probe_outside;
          ALTER DEFAULT PRIVILEGES IN SCHEMA audit_probe_outside GRANT SELECT ON TABLES TO fs_billing_audit`);
        return violations(client);
      }),
    ).toEqual([]);
  });

  it('audit_role_violations still reports the grant option after the auditor delegates it', async () => {
    expect(
      await rolledBack(async (client) => {
        await client.query(auditQueryGrantOption);
        await client.query('SET LOCAL ROLE fs_billing_audit');
        await client.query(
          'GRANT EXECUTE ON FUNCTION audit_operation_logs(text, text, timestamptz, timestamptz) TO fs_billing_app',
        );
        await client.query('RESET ROLE');
        return violations(client);
      }),
    ).toEqual([auditQueryGrantOptionLine]);
  });

  it.each([
    [
      'membership',
      'GRANT fs_billing_app TO fs_billing_audit',
      '是角色 fs_billing_app 的成员',
    ],
    [
      'PUBLIC EXECUTE on an auth writer',
      publicAuthInsert,
      '函数 auth.insert_user(text,text,text)：EXECUTE',
    ],
    [
      'default table privilege',
      defaultTableUpdate,
      '默认权限：fs_billing 在 schema public 新建的表授予 fs_billing_audit UPDATE',
    ],
    [
      'a default EXECUTE WITH GRANT OPTION on new functions',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO fs_billing_audit WITH GRANT OPTION',
      auditQueryGrantOptionLine,
    ],
  ])(
    'migration refuses a pre-existing audit role after %s',
    async (_, dirty, violation) => {
      const error = await rolledBack(async (client) => {
        await client.query(dirty);
        await client.query(dropAuditFunctions);
        return pgError(client.query(await migration));
      });
      expect(error.code).toBe('P0001');
      expect(error.message).toContain('fs_billing_audit 超出只读权限：');
      expect(error.message).toContain(violation);
    },
  );

  it('migration replays over a clean pre-existing audit role', async () => {
    expect(
      await rolledBack(async (client) => {
        await client.query(dropAuditFunctions);
        await client.query(await migration);
        return violations(client);
      }),
    ).toEqual([]);
  });

  it('application role cannot execute the audit query', async () => {
    expect(
      await pgError(app.pool.query('SELECT * FROM audit_operation_logs()')),
    ).toMatchObject({ code: '42501' });
  });

  it('application role cannot execute audit_role_violations', async () => {
    expect(
      await pgError(app.pool.query('SELECT * FROM audit_role_violations()')),
    ).toMatchObject({ code: '42501' });
  });
});
