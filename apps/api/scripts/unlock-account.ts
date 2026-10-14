import pg from 'pg';
import { z } from 'zod';
import { normalizeEmail } from '../src/auth/gateway.js';

const email = z.email().parse(process.argv[2]);
const url = z.url().parse(process.env['DATABASE_URL']);
if (
  ['fs_billing_app', 'fs_billing_auth'].includes(
    decodeURIComponent(new URL(url).username),
  )
)
  throw new Error('紧急解锁必须使用 owner DATABASE_URL');
const pool = new pg.Pool({ connectionString: url });
try {
  const result = await pool.query(
    'DELETE FROM auth.login_failures WHERE email_key=$1',
    [normalizeEmail(email)],
  );
  process.stdout.write(`解除锁定计数 ${result.rowCount ?? 0} 行\n`);
} finally {
  await pool.end();
}
