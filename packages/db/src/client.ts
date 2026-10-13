import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { z } from 'zod';
import * as schema from './schema.js';

export const APP_ROLE = 'fs_billing_app';

const postgresUrl = z.url().refine((value) => /^postgres(?:ql)?:/.test(value), {
  message: '必须使用 PostgreSQL 协议',
});

/** DATABASE_URL：owner，用于迁移与种子；APP_DATABASE_URL：应用角色，RLS 生效。 */
export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: postgresUrl,
  APP_DATABASE_URL: postgresUrl.refine(
    (value) => decodeURIComponent(new URL(value).username) === APP_ROLE,
    { message: `应用连接必须使用 ${APP_ROLE} 角色` },
  ),
});
export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Connection {
  readonly db: Db;
  readonly pool: pg.Pool;
}

// numeric 原样以字符串返回（pg 默认如此）；timestamptz 解析为 Date。
export function connect(url: string): Connection {
  const pool = new pg.Pool({ connectionString: url });
  return { pool, db: drizzle(pool, { schema }) };
}

/** 以租户身份执行：RLS 只放行该租户的行。 */
export function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.scope', 'tenant', true), set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return fn(tx);
  });
}

/** 以管理员/系统身份执行：可见全部租户。 */
export function withAdmin<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
    return fn(tx);
  });
}
