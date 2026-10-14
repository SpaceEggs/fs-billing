import pg from 'pg';
import { requireEnv } from './env';

/** owner 连接，只用于测试准备：撤销会话、清除锁定计数。 */
async function withOwner<T>(work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({
    connectionString: requireEnv('DATABASE_URL'),
  });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

export function revokeSessions(email: string) {
  return withOwner((client) =>
    client.query(
      'DELETE FROM auth.session WHERE user_id IN (SELECT id FROM auth.user WHERE email = $1)',
      [email.toLowerCase()],
    ),
  );
}

export function clearLoginFailures(email: string) {
  return withOwner((client) =>
    client.query('DELETE FROM auth.login_failures WHERE email_key = $1', [
      email.toLowerCase(),
    ]),
  );
}
