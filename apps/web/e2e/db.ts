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

const shanghaiOffsetMs = 8 * 60 * 60 * 1000;
const dayMs = 24 * 60 * 60 * 1000;

/** 某一时刻的北京时间日期（YYYY-MM-DD）。Asia/Shanghai 固定 UTC+8、没有夏令时。 */
export function shanghaiDate(instant: Date | string) {
  return new Date(new Date(instant).getTime() + shanghaiOffsetMs)
    .toISOString()
    .slice(0, 10);
}

/**
 * 以 Worker 入账的形状给租户记一通已接通（扣 `charge`、计 `minutes` 分钟）和一通未接通的电话。
 * 时刻只取一次数据库时间：两通电话从 3 秒前开始，若会跨过北京时间零点则改从当日零点开始，
 * 全部时刻落在同一北京日（因而同一月）内。返回该日期，供断言与概况的 asOf 对照。
 */
export function recordCalls(
  tenantId: string,
  { charge, minutes }: { charge: string; minutes: string },
) {
  return withOwner(async (client) => {
    const { rows } = await client.query<{ now: Date }>('SELECT now() AS now');
    const now = rows[0]!.now.getTime();
    const dayStart =
      Math.floor((now + shanghaiOffsetMs) / dayMs) * dayMs - shanghaiOffsetMs;
    const startedMs = Math.max(now - 3000, dayStart);
    const started = new Date(startedMs);
    const answered = new Date(startedMs + 1000);
    const ended = new Date(startedMs + 3000);

    // 建分区不能和持租户锁的写入同一事务（ensure_month_partition 拒绝，lock_tenants 也拒绝已持强表锁的事务）。
    // 分区按将要写入的 started_at 建，不取事务时间。
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT cdr_ensure_partitions($1, 0)', [started]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenantId]);
      const answeredCall = randomUUID();
      await client.query(
        `INSERT INTO cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
           billing_number, duration_seconds, billed_minutes, matched_prefix, country, rate, charge,
           hangup_cause)
         VALUES ($1, $2, $6, $7, $8,
           '1000', '8613800138000', '8613800138000', 2, $3, '86', '中国', '0.1', $4,
           'NORMAL_CLEARING'),
           ($1, $5, $6, NULL, $8,
           '1000', '8613800138000', '8613800138000', 0, 0, NULL, NULL, NULL, 0, 'CALL_REJECTED')`,
        [
          tenantId,
          answeredCall,
          minutes,
          charge,
          randomUUID(),
          started,
          answered,
          ended,
        ],
      );
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
         VALUES ($1, 'call_charge', -$2::numeric, $3, $4)`,
        [tenantId, charge, `call:${answeredCall}`, answered],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return { day: shanghaiDate(started) };
  });
}

/**
 * 给租户记一笔 `daysAgo` 天前的赊账（待收款）。应用角色不能指定 created_at，所以由 owner 写入；
 * 操作人为管理员 `adminEmail`。返回流水 ID。
 */
export function recordPastCredit(
  tenantId: string,
  {
    amount,
    note,
    daysAgo,
    adminEmail,
  }: { amount: string; note: string; daysAgo: number; adminEmail: string },
) {
  return withOwner(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenantId]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key,
           occurred_at, created_at)
         SELECT $1, 'credit_recharge', $2::numeric, $3, admins.id, $4,
           now() - make_interval(days => $5), now() - make_interval(days => $5)
         FROM admins JOIN auth.user u ON u.id = admins.auth_user_id WHERE u.email = lower($6)
         RETURNING id`,
        [tenantId, amount, note, randomUUID(), daysAgo, adminEmail],
      );
      await client.query('COMMIT');
      return rows[0]!.id;
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

/** 租户的操作日志，按发生顺序。 */
export function operationLogs(tenantId: string) {
  return withOwner(async (client) => {
    const { rows } = await client.query<{
      action: string;
      target: string;
      content: Record<string, unknown>;
    }>(
      `SELECT action, target, details->'content' AS content FROM operation_logs
       WHERE tenant_id = $1 ORDER BY created_at, id`,
      [tenantId],
    );
    return rows;
  });
}
