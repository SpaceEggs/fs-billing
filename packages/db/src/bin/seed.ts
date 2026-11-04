import { parseArgs } from 'node:util';
import { connect, databaseEnvironmentSchema } from '../client.js';
import { seedDatabase } from '../seed.js';
import { assertSeedAllowed, SeedRefused } from '../seed-guard.js';

let force: boolean;
try {
  force =
    parseArgs({ options: { force: { type: 'boolean', default: false } } })
      .values.force ?? false;
} catch {
  throw new Error('用法：pnpm db:seed [--force]');
}

const nodeEnv = process.env.NODE_ENV;
try {
  // 生产环境不连接数据库直接拒绝；其余情况先确认库是否已有数据。
  assertSeedAllowed({ nodeEnv, hasData: false, force });
  const { pool, db } = connect(
    databaseEnvironmentSchema.parse(process.env).DATABASE_URL,
  );
  try {
    // 迁移还没跑时这里会报表不存在，操作者应先 pnpm db:migrate。
    const { rows } = await pool.query<{ present: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM public.tenants) AS present',
    );
    assertSeedAllowed({ nodeEnv, hasData: rows[0]!.present, force });
    await seedDatabase(db);
    const { rows: tenants } = await pool.query<{
      code: string;
      balance: string;
    }>(
      `SELECT t.code, t.currency, to_char(b.balance, 'FM999999990.00') AS balance
       FROM tenants t JOIN tenant_balances b ON b.tenant_id = t.id ORDER BY t.code`,
    );
    console.table(tenants);
  } finally {
    await pool.end();
  }
} catch (error) {
  if (error instanceof SeedRefused) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else throw error;
}
