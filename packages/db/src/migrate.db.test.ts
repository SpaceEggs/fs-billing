import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, inject, it } from 'vitest';
import { connections } from '../test/support.js';
import { migrateDatabase } from './migrate.js';
import * as schema from './schema.js';

const { app, owner } = connections();

describe('迁移', () => {
  it('在已迁移的库上再执行一次不报错，也不重复记录', async () => {
    await migrateDatabase({
      DATABASE_URL: inject('ownerUrl'),
      APP_DATABASE_URL: inject('appUrl'),
    });
    const { rows } = await owner.pool.query(
      'SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations',
    );
    expect(rows).toEqual([{ applied: 2 }]);
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

  it('除管理员表与未归属话单外，每张业务表都有 tenant_id', async () => {
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
    expect(tables).toHaveLength(17);
  });
});
