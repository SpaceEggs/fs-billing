import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { APP_ROLE, connect, type DatabaseEnvironment } from './client.js';

const migrationsFolder = fileURLToPath(
  new URL('../migrations', import.meta.url),
);

/**
 * 以 owner 执行未应用的迁移，再设置应用角色的登录密码并建当月与下月话单分区。
 * 每一步都幂等，可重复执行。
 */
export async function migrateDatabase(env: DatabaseEnvironment): Promise<void> {
  const { db, pool } = connect(env.DATABASE_URL);
  try {
    await migrate(db, { migrationsFolder });
    const password = decodeURIComponent(new URL(env.APP_DATABASE_URL).password);
    const { rows } = await pool.query<{ statement: string }>(
      'SELECT format($1, $2::text, $3::text) AS statement',
      ['ALTER ROLE %I WITH LOGIN PASSWORD %L', APP_ROLE, password],
    );
    await pool.query(rows[0]!.statement);
    await db.execute(sql`select cdr_ensure_partitions()`);
  } finally {
    await pool.end();
  }
}
