import { connect, databaseEnvironmentSchema } from '../client.js';
import { seedDatabase } from '../seed.js';

const { pool, db } = connect(
  databaseEnvironmentSchema.parse(process.env).DATABASE_URL,
);
try {
  await seedDatabase(db);
  const { rows } = await pool.query<{ code: string; balance: string }>(
    `SELECT t.code, t.currency, to_char(b.balance, 'FM999999990.00') AS balance
     FROM tenants t JOIN tenant_balances b ON b.tenant_id = t.id ORDER BY t.code`,
  );
  console.table(rows);
} finally {
  await pool.end();
}
