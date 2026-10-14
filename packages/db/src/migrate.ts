import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  APP_ROLE,
  AUTH_ROLE,
  connect,
  type DatabaseEnvironment,
} from './client.js';
import { ensureCdrPartitions } from './partitions.js';

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
    const roles = [
      [APP_ROLE, env.APP_DATABASE_URL],
      ...(env.AUTH_DATABASE_URL ? [[AUTH_ROLE, env.AUTH_DATABASE_URL]] : []),
    ];
    for (const [role, url] of roles) {
      const password = decodeURIComponent(new URL(url!).password);
      const { rows } = await pool.query<{ statement: string }>(
        'SELECT format($1, $2::text, $3::text) AS statement',
        ['ALTER ROLE %I WITH LOGIN PASSWORD %L', role!, password],
      );
      await pool.query(rows[0]!.statement);
    }
    await ensureCdrPartitions(db);
  } finally {
    await pool.end();
  }
}
