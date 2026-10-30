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

export type CdrFixture = {
  startedAt: string;
  /** 未接通为 null；此时国家、前缀、费率也须为 null，时长与费用为 0。 */
  answeredAt: string | null;
  endedAt: string;
  caller: string;
  /** 客户拨出的原始号码。 */
  callee: string;
  /** 归一化后的计费号码（首位 1-9，不含 + 和 00）。 */
  billingNumber: string;
  country: string | null;
  iso: string | null;
  description: string | null;
  prefix: string | null;
  rate: string | null;
  durationSeconds: number;
  minutes: string;
  charge: string;
  hangupCause: string;
  unverified: boolean;
};

/**
 * 以 Worker 入账后的形状直接写入话单（含 ISO 与说明），用于话单页的 e2e。
 * 只写 cdrs，不写流水：话单页不读余额。每次调用用新的 call_uuid，返回它们（与入参同序）。
 */
export function recordCdrs(tenantId: string, cdrRows: readonly CdrFixture[]) {
  return withOwner(async (client) => {
    // 建分区不能和持租户锁的写入同一事务，见 recordCalls。
    for (const month of new Set(
      cdrRows.map((cdr) => cdr.startedAt.slice(0, 7)),
    )) {
      await client.query('BEGIN');
      try {
        await client.query("SELECT set_config('app.scope', 'system', true)");
        await client.query('SELECT cdr_ensure_partitions($1::timestamptz, 0)', [
          `${month}-15T00:00:00Z`,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenantId]);
      const uuids: string[] = [];
      for (const cdr of cdrRows) {
        const callUuid = randomUUID();
        uuids.push(callUuid);
        await client.query(
          `INSERT INTO cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
             billing_number, duration_seconds, billed_minutes, matched_prefix, country, iso, description,
             rate, charge, hangup_cause, unverified)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            tenantId,
            callUuid,
            cdr.startedAt,
            cdr.answeredAt,
            cdr.endedAt,
            cdr.caller,
            cdr.callee,
            cdr.billingNumber,
            cdr.durationSeconds,
            cdr.minutes,
            cdr.prefix,
            cdr.country,
            cdr.iso,
            cdr.description,
            cdr.rate,
            cdr.charge,
            cdr.hangupCause,
            cdr.unverified,
          ],
        );
      }
      await client.query('COMMIT');
      return uuids;
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

/** 把租户的创建时间改到过去（owner 连接），使更早的月份也有应有的账单。 */
export function backdateTenant(tenantId: string, createdAt: string) {
  return withOwner((client) =>
    client.query(
      'UPDATE tenants SET created_at = $2::timestamptz WHERE id = $1',
      [tenantId, createdAt],
    ),
  );
}

/** 一笔 `at` 时刻（带时区的时间文本）发生的人工流水，操作人为管理员 `adminEmail`。 */
export function recordLedgerEntry(
  tenantId: string,
  {
    kind,
    amount,
    at,
    adminEmail,
  }: {
    kind: 'recharge' | 'gift' | 'adjustment';
    amount: string;
    at: string;
    adminEmail: string;
  },
) {
  return withOwner(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenantId]);
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key,
           occurred_at, created_at)
         SELECT $1, $2, $3::numeric, '端到端', admins.id, $4, $5::timestamptz, $5::timestamptz
         FROM admins JOIN auth.user u ON u.id = admins.auth_user_id WHERE u.email = lower($6)`,
        [tenantId, kind, amount, randomUUID(), at, adminEmail],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * 一通 `answeredAt`（带时区的时间文本）接通的电话：话单加对应的 `call:<uuid>` 扣费流水，
 * 与 Worker 入账后的形状一致。用于账单页的 e2e：账单头部来自流水、国家与日明细来自话单。
 */
export function recordStatementCall(
  tenantId: string,
  {
    answeredAt,
    minutes,
    charge,
    country = '中国',
  }: { answeredAt: string; minutes: string; charge: string; country?: string },
) {
  return withOwner(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT cdr_ensure_partitions($1::timestamptz, 0)', [
        answeredAt,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      await client.query('SELECT lock_tenants(ARRAY[$1]::uuid[])', [tenantId]);
      const callUuid = randomUUID();
      await client.query(
        `INSERT INTO cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
           billing_number, duration_seconds, billed_minutes, matched_prefix, country, iso, rate, charge,
           hangup_cause)
         VALUES ($1, $2, $3::timestamptz - interval '3 seconds', $3::timestamptz,
           $3::timestamptz + interval '61 seconds', '1000', '8613800138000', '8613800138000', 61, $4,
           '86', $5, 'CN', '0.5', $6, 'NORMAL_CLEARING')`,
        [tenantId, callUuid, answeredAt, minutes, country, charge],
      );
      await client.query(
        `INSERT INTO ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
         VALUES ($1, 'call_charge', -$2::numeric, $3, $4::timestamptz)`,
        [tenantId, charge, `call:${callUuid}`, answeredAt],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/**
 * 直接设置某月账单的核对结果或话单已删除标志（owner 连接）。
 * 核对任务由 Worker 运行，e2e 不启动 Worker，所以核对结果由这里直接置。
 * 话单已删除标志在产品里只由删除话单的事务置位（阶段 8，admin-cdr-deletion.spec 走真实界面）；
 * 这里直接置位，只用于不关心删除过程的账单页用例。
 */
export function setStatementFlags(
  tenantId: string,
  month: string,
  flags: {
    reconcileStatus?: 'ok' | 'stale' | 'inconsistent';
    reconcileDiff?: string;
    detailsDeleted?: true;
  },
) {
  return withOwner(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE monthly_statements SET
         reconcile_status = coalesce($3, reconcile_status),
         reconcile_diff = coalesce($4::numeric, reconcile_diff),
         reconciled_at = CASE WHEN $3::text IS NULL THEN reconciled_at ELSE now() END,
         details_deleted = details_deleted OR $5
       WHERE tenant_id = $1 AND month = $2::date`,
      [
        tenantId,
        `${month}-01`,
        flags.reconcileStatus ?? null,
        flags.reconcileDiff ?? null,
        flags.detailsDeleted ?? false,
      ],
    );
    if (rowCount !== 1) throw new Error(`no statement ${tenantId} ${month}`);
  });
}

export type UnassignedFixture = {
  /** 被叫（归一化后即计费号码），默认中国号码。 */
  callee?: string;
  /** 通话秒数，默认 61（2 个计费分钟）。 */
  seconds?: number;
  reason?: string;
};

/**
 * 往 unassigned_cdrs 写若干待处理话单（owner 连接）。接通时刻取数据库当前时间：
 * 租户的费率版本从创建时起生效，接通在它之后才有费率，所以用例不依赖运行日期，
 * 补扣费落入运行当月。返回通话 UUID（与入参同序）。
 */
export function recordUnassigned(
  tag: string,
  rows: readonly UnassignedFixture[],
) {
  return withOwner(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SELECT set_config('app.scope', 'system', true)");
      const uuids: string[] = [];
      for (const row of rows) {
        const callUuid = randomUUID();
        uuids.push(callUuid);
        const callee = row.callee ?? '8613800138000';
        const seconds = row.seconds ?? 61;
        await client.query(
          `INSERT INTO unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, answered_at,
             ended_at, caller, callee, billing_number, duration_seconds, hangup_cause)
           VALUES ($1, $2, $3, now() - interval '5 seconds', now(),
             now() + make_interval(secs => $4), '075586001234', $5, $5, $4, 'NORMAL_CLEARING')`,
          [tag, callUuid, row.reason ?? '租户不存在', seconds, callee],
        );
      }
      await client.query('COMMIT');
      return uuids;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** 租户当前余额（owner 连接读 tenant_balances）。 */
export function tenantBalance(tenantId: string) {
  return withOwner(async (client) => {
    const { rows } = await client.query<{ balance: string }>(
      'SELECT balance::text AS balance FROM tenant_balances WHERE tenant_id = $1',
      [tenantId],
    );
    return rows[0]?.balance ?? '0';
  });
}

/** 租户的通话扣费流水（金额为负），按发生顺序。 */
export function callChargeEntries(tenantId: string) {
  return withOwner(async (client) => {
    const { rows } = await client.query<{ amount: string; key: string }>(
      `SELECT amount::text AS amount, idempotency_key AS key FROM ledger_entries
       WHERE tenant_id = $1 AND kind = 'call_charge' ORDER BY occurred_at, id`,
      [tenantId],
    );
    return rows;
  });
}

/** 租户的话单（cdrs）条数与合计费用。 */
export function cdrTotals(tenantId: string) {
  return withOwner(async (client) => {
    const { rows } = await client.query<{ count: number; charge: string }>(
      `SELECT count(*)::int AS count, coalesce(sum(charge), 0)::text AS charge FROM cdrs
       WHERE tenant_id = $1`,
      [tenantId],
    );
    return rows[0]!;
  });
}

/**
 * 租户账单头部与话单明细的快照（owner 连接），删除话单前后对比用：
 * 流水只取不可变的列，账单头部排除删除元数据三列。
 */
export function ledgerAndStatementSnapshot(tenantId: string) {
  return withOwner(async (client) => {
    const ledger = await client.query<{ rows: string }>(
      `SELECT coalesce(string_agg(id::text || ':' || kind || ':' || amount::text || ':' ||
         occurred_at::text, ',' ORDER BY id), '') AS rows FROM ledger_entries WHERE tenant_id = $1`,
      [tenantId],
    );
    const statements = await client.query<{ rows: string }>(
      `SELECT coalesce(string_agg((to_jsonb(s) - 'details_deleted' - 'details_deleted_at' -
         'details_deleted_by' - 'details_deleted_count')::text, ','
         ORDER BY month), '') AS rows FROM monthly_statements s WHERE tenant_id = $1`,
      [tenantId],
    );
    const balance = await client.query<{ balance: string }>(
      'SELECT balance::text AS balance FROM tenant_balances WHERE tenant_id = $1',
      [tenantId],
    );
    return {
      ledger: ledger.rows[0]!.rows,
      statements: statements.rows[0]!.rows,
      balance: balance.rows[0]?.balance ?? '0',
    };
  });
}

/** 为系统告警页面冒烟测试创建一条独立告警。 */
export async function createSystemAlert() {
  return withOwner(async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO system_alerts (kind, subject_key, description)
       VALUES ('auth_timeout', $1, '端到端授权超时') RETURNING id`,
      [`e2e:${randomUUID()}`],
    );
    return result.rows[0]!.id;
  });
}

export function removeSystemAlert(id: string) {
  return withOwner((client) =>
    client.query('DELETE FROM system_alerts WHERE id = $1', [id]),
  );
}
