import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireEnv } from './env';

/** owner 连接，只用于测试准备：撤销会话、清除锁定计数、写入话单。 */
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

/**
 * 以 Worker 入账的形状给租户记一通已接通（扣 `charge`、计 `minutes` 分钟）和一通未接通的电话，
 * 时间取数据库当前时刻，落在概况的本月与今日内。
 */
export function recordCalls(
  tenantId: string,
  { charge, minutes }: { charge: string; minutes: string },
) {
  return withOwner(async (client) => {
    // 建分区不能和持租户锁的写入同一事务（ensure_month_partition 拒绝，lock_tenants 也拒绝已持强表锁的事务）。
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT cdr_ensure_partitions(now(), 0)');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenantId]);
      const answered = randomUUID();
      await client.query(
        `INSERT INTO cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
           billing_number, duration_seconds, billed_minutes, matched_prefix, country, rate, charge,
           hangup_cause)
         VALUES ($1, $2, now() - interval '3 seconds', now() - interval '2 seconds', now(),
           '1000', '8613800138000', '8613800138000', 2, $3, '86', '中国', '0.1', $4,
           'NORMAL_CLEARING'),
           ($1, $5, now() - interval '3 seconds', NULL, now(),
           '1000', '8613800138000', '8613800138000', 0, 0, NULL, NULL, NULL, 0, 'CALL_REJECTED')`,
        [tenantId, answered, minutes, charge, randomUUID()],
      );
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
         VALUES ($1, 'call_charge', -$2::numeric, $3, now() - interval '2 seconds')`,
        [tenantId, charge, `call:${answered}`],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

export function clearLoginFailures(email: string) {
  return withOwner((client) =>
    client.query('DELETE FROM auth.login_failures WHERE email_key = $1', [
      email.toLowerCase(),
    ]),
  );
}
