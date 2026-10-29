import { is } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, inject, it } from 'vitest';
import { connections, createTenant, pgError } from '../test/support.js';
import { withAdmin } from './client.js';
import { migrateDatabase } from './migrate.js';
import * as schema from './schema.js';

const { app, owner } = connections();

describe('迁移', () => {
  it('preview foreign key, payload check and expiry index metadata match the migration', async () => {
    const config = getTableConfig(schema.adminRatePreviews);
    expect(config.foreignKeys.map((key) => key.getName())).toEqual([
      'admin_rate_previews_tenant_id_fkey',
    ]);
    const reference = config.foreignKeys[0]!.reference();
    expect(reference.foreignTable).toBe(schema.tenants);
    expect(reference.columns.map((column) => column.name)).toEqual([
      'tenant_id',
    ]);
    expect(reference.foreignColumns.map((column) => column.name)).toEqual([
      'id',
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual([
      'admin_rate_previews_payload_check',
    ]);
    expect(config.indexes.map((entry) => entry.config.name)).toEqual([
      'admin_rate_previews_expiry',
    ]);
    expect(
      (
        await owner.pool.query<{ name: string }>(
          "SELECT conname AS name FROM pg_constraint WHERE conrelid = 'admin_rate_previews'::regclass AND contype IN ('f','c') ORDER BY conname",
        )
      ).rows.map((row) => row.name),
    ).toEqual([
      'admin_rate_previews_payload_check',
      'admin_rate_previews_tenant_id_fkey',
    ]);
  });
  it('tenant codes have case-insensitive uniqueness', async () => {
    const tenant = await createTenant(app, 'CNY');
    expect(
      await pgError(
        withAdmin(app.db, (tx) =>
          tx.insert(schema.tenants).values({
            code: tenant.code.toLowerCase(),
            name: 'duplicate',
            currency: 'CNY',
            overdraftLimit: '0',
          }),
        ),
      ),
    ).toMatchObject({
      code: '23505',
      constraint: 'tenants_code_case_insensitive',
    });
  });

  it('migration precheck loudly lists every colliding code and ID before any schema changes', async () => {
    const migration = await readFile(
      new URL('../migrations/0006_admin_receivables.sql', import.meta.url),
      'utf8',
    );
    const precheck = migration.split('--> statement-breakpoint')[0]!;
    const client = await owner.pool.connect();
    const base = `COLLISION${randomUUID().replaceAll('-', '')}`;
    const ids = [randomUUID(), randomUUID()];
    try {
      await client.query('begin');
      await client.query('drop index tenants_code_case_insensitive');
      await client.query(
        "insert into tenants(id,code,name,currency,overdraft_limit) values($1,$2,'A','CNY',0),($3,$4,'B','CNY',0)",
        [ids[0], base, ids[1], base.toLowerCase()],
      );
      const error = await pgError(client.query(precheck));
      expect(error.message).toContain('manually rename');
      for (const value of [base, base.toLowerCase(), ...ids])
        expect(error.message).toContain(value);
    } finally {
      await client.query('rollback');
      client.release();
    }
    expect(
      (
        await owner.pool.query(
          "select indexname from pg_indexes where indexname='tenants_code_case_insensitive'",
        )
      ).rows,
    ).toHaveLength(1);
  });

  it('migration precheck lists every duplicate auth credential before adding uniqueness', async () => {
    const migration = await readFile(
      new URL('../migrations/0007_auth_credentials.sql', import.meta.url),
      'utf8',
    );
    const precheck = migration.split('--> statement-breakpoint')[0]!;
    const client = await owner.pool.connect();
    const userId = randomUUID();
    const ids = [randomUUID(), randomUUID()];
    try {
      await client.query('begin');
      await client.query(
        'INSERT INTO auth."user"(id,name,email) VALUES($1,$2,$3)',
        [userId, 'dup', `${userId}@example.invalid`],
      );
      await client.query(
        'ALTER TABLE auth.account DROP CONSTRAINT account_user_id_provider_id_key',
      );
      await client.query(
        "INSERT INTO auth.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,$2,'credential',$2,'a',now()),($3,$2,'credential',$2,'b',now())",
        [ids[0], userId, ids[1]],
      );
      const error = await pgError(client.query(precheck));
      expect(error.message).toContain('choose which credential survives');
      expect(error.message).toContain(userId);
      for (const id of ids) expect(error.message).toContain(id);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('在已迁移的库上再执行一次不报错，也不重复记录', async () => {
    await migrateDatabase({
      DATABASE_URL: inject('ownerUrl'),
      APP_DATABASE_URL: inject('appUrl'),
    });
    const { rows } = await owner.pool.query(
      'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations',
    );
    expect(rows).toEqual([{ applied: 24 }]);
  });

  it('应用以非超级用户、非 BYPASSRLS 的角色连接', async () => {
    const { rows } = await app.pool.query(
      'SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    expect(rows).toEqual([
      { role: 'fs_billing_app', rolsuper: false, rolbypassrls: false },
    ]);
  });

  it('public 中每张表都启用了 RLS', async () => {
    const { rows } = await owner.pool.query(
      `SELECT relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity`,
    );
    expect(rows).toEqual([]);
  });

  it('除管理员表、未归属话单与原始话单归档清单（按月，不属于某个租户）外，每张业务表都有 tenant_id', async () => {
    const { rows } = await owner.pool.query(
      `SELECT c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND NOT EXISTS (
           SELECT FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id'
         )
       ORDER BY 1`,
    );
    expect(rows.map((r: { relname: string }) => r.relname)).toEqual([
      'admins',
      'alert_settings',
      'raw_cdr_archives',
      'tenants',
      'unassigned_cdrs',
    ]);
  });

  it('金额与时间列的类型：没有 float/real/money，也没有不带时区的 timestamp', async () => {
    const { rows } = await owner.pool.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type IN ('real', 'double precision', 'money', 'timestamp without time zone')`,
    );
    expect(rows).toEqual([]);
  });

  it('Drizzle 表描述与迁移后的列一一对应', async () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (value): value is PgTable => is(value, PgTable),
    );
    const { rows } = await owner.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [tables.map((t) => getTableConfig(t).name)],
    );
    const actual = new Map<string, string[]>();
    for (const r of rows)
      actual.set(r.table_name, [
        ...(actual.get(r.table_name) ?? []),
        r.column_name,
      ]);
    for (const table of tables) {
      const config = getTableConfig(table);
      expect(actual.get(config.name)?.sort(), config.name).toEqual(
        config.columns.map((c) => c.name).sort(),
      );
    }
    expect(tables).toHaveLength(27);
  });
});

it('adds ISO and description defaults to rates and nullable columns to CDR partitions with validated checks', async () => {
  const { rows } = await owner.pool.query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `select table_name, column_name, is_nullable, column_default from information_schema.columns where table_schema='public' and (table_name='rate_entries' or table_name='cdrs' or table_name like 'cdrs_2026_%') and column_name in ('iso','description')`,
  );
  expect(rows.filter((row) => row.table_name === 'rate_entries')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        column_name: 'iso',
        is_nullable: 'NO',
        column_default: "''::text",
      }),
      expect.objectContaining({
        column_name: 'description',
        is_nullable: 'NO',
        column_default: "''::text",
      }),
    ]),
  );
  const cdrColumns = rows.filter((row) => row.table_name !== 'rate_entries');
  expect(cdrColumns.length).toBeGreaterThan(2);
  for (const column of cdrColumns)
    expect(column).toMatchObject({ is_nullable: 'YES', column_default: null });
  const checks = await owner.pool.query<{
    conname: string;
    convalidated: boolean;
  }>(
    `select conname, convalidated from pg_constraint where conname in ('rate_entries_iso_check', 'cdrs_iso_check')`,
  );
  expect(checks.rows.length).toBeGreaterThanOrEqual(2);
  for (const check of checks.rows) expect(check.convalidated).toBe(true);
});

it('migration preserves old country text and adds empty metadata without rewriting rows', async () => {
  const migration = await readFile(
    new URL(
      '../migrations/0016_rate_list_iso_description.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const client = await owner.pool.connect();
  try {
    await client.query('begin');
    await client.query(`create temporary table rate_entries (country text not null);
      create temporary table cdrs (country text, started_at date) partition by range (started_at);
      create temporary table old_cdr_partition partition of cdrs for values from ('2026-10-01') to ('2026-11-01');
      insert into rate_entries values ('英国手机');
      insert into cdrs values ('英国手机', '2026-10-01')`);
    const before = await client.query(
      `select oid, relfilenode from pg_class where oid in ('pg_temp.rate_entries'::regclass,'pg_temp.old_cdr_partition'::regclass) order by oid`,
    );
    await client.query(migration);
    expect(
      (
        await client.query(
          'select iso, country, description from pg_temp.rate_entries',
        )
      ).rows,
    ).toEqual([{ iso: '', country: '英国手机', description: '' }]);
    expect(
      (await client.query('select iso, country, description from pg_temp.cdrs'))
        .rows,
    ).toEqual([{ iso: null, country: '英国手机', description: null }]);
    expect(
      (
        await client.query(
          `select oid, relfilenode from pg_class where oid in ('pg_temp.rate_entries'::regclass,'pg_temp.old_cdr_partition'::regclass) order by oid`,
        )
      ).rows,
    ).toEqual(before.rows);
    await expect(
      client.query("update pg_temp.cdrs set iso='gb'"),
    ).rejects.toMatchObject({ code: '23514', constraint: 'cdrs_iso_check' });
  } finally {
    await client.query('rollback');
    client.release();
  }
});
