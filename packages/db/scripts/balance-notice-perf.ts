import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { cpus, platform, release, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { z } from 'zod';
import { connect, lockTenants, withSystem } from '../src/client.js';
import { chargeCall } from '../src/cdr-intake.js';
import { ensureCdrPartitions } from '../src/partitions.js';
import { migrateDatabase } from '../src/migrate.js';
import { seedDatabase } from '../src/seed.js';

/**
 * 余额通知触发器对扣费热路径的影响（阶段 9 PR 3，设计「判定放在哪里」）。
 *
 * 在一个 PORTALBIG 形状的数据库上（本机 Docker PostgreSQL 17.9：PORTALBIG 租户 300 万条话单、285 万笔扣费流水，
 * 另有 40 个小租户）交替运行「触发器启用」与「触发器停用」两种状态下的真实扣费（`chargeCall`，与 Worker 的
 * `chargeCdr` 相同：租户锁 + 读话单费率快照 + 写流水 + 缓存余额触发器），记录吞吐和单笔事务耗时。
 * 「停用」就是迁移之前的状态：0023 在扣费路径上只增加这一个触发器（tenants 上的触发器只在开户时执行）。
 *
 *   setup：建库、迁移、播种、灌 PORTALBIG 形状的数据（会写库，只允许 fs_billing_perf_ 开头的库）
 *   run  ：交替测量，结果写到 --out 指定的 JSON
 *
 * 用法（示例）：
 *   PERF_OWNER_URL=postgresql://fs_billing:…@127.0.0.1:55443/fs_billing_perf_p9pr3 \
 *   PERF_APP_URL=postgresql://fs_billing_app:…@127.0.0.1:55443/fs_billing_perf_p9pr3 \
 *   pnpm --filter @fs-billing/db exec tsx scripts/balance-notice-perf.ts setup|run [--out file.json]
 */
const mode = z.enum(['setup', 'run']).parse(process.argv[2]);
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : undefined;
const ownerUrl = z.url().parse(process.env.PERF_OWNER_URL);
const appUrl = z.url().parse(process.env.PERF_APP_URL);
for (const [url, user] of [
  [ownerUrl, 'fs_billing'],
  [appUrl, 'fs_billing_app'],
] as const) {
  const parsed = new URL(url);
  assert(parsed.pathname.startsWith('/fs_billing_perf_'), '只允许性能库');
  assert.equal(parsed.username, user);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
}

const PORTALBIG_CDRS = 3_000_000;
const PORTALBIG_LEDGER = 2_850_000;
const SMALL_TENANTS = 40;
const BIG = '00000000-0000-4000-8000-000000000001';
const FIRST_START = '2025-10-17T04:00:00Z';

const ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
const ms = (started: number) =>
  ((performance.now() - started) / 1000).toFixed(1);

async function setup() {
  const started = performance.now();
  const adminUrl = new URL(ownerUrl);
  const database = adminUrl.pathname.slice(1);
  adminUrl.pathname = '/postgres';
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${database}`);
  await admin.end();

  const appParsed = new URL(appUrl);
  await migrateDatabase({
    DATABASE_URL: ownerUrl,
    APP_DATABASE_URL: appUrl,
    AUTH_DATABASE_URL: Object.assign(new URL(appUrl), {
      username: 'fs_billing_auth',
    }).toString(),
  });
  assert(appParsed.password);
  const owner = connect(ownerUrl, { max: 2 });
  await seedDatabase(owner.db);
  await owner.pool.end();
  console.log(`迁移与种子完成 ${ms(started)}s`);

  // 话单分区：2025-10 到 2026-10。
  for (let month = 0; month < 13; month++) {
    const moment = new Date(Date.UTC(2025, 9 + month, 20));
    const db = connect(ownerUrl, { max: 1 });
    await ensureCdrPartitions(db.db, { moment, monthsAhead: 0 });
    await db.pool.end();
  }

  const client = await ownerPool.connect();
  try {
    // 批量灌数：跳过触发器和外键（需要超级用户），之后手工把缓存余额对齐到流水合计。
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into tenants (id, code, name, currency, overdraft_limit)
       values ($1, 'PORTALBIG', 'PORTALBIG', 'CNY', 100)`,
      [BIG],
    );
    await client.query(`insert into tenant_balances (tenant_id) values ($1)`, [
      BIG,
    ]);
    await client.query(
      `insert into balance_alert_settings (tenant_id, threshold, emails) values ($1, 100, array['perf@example.test'])`,
      [BIG],
    );
    await client.query(
      `insert into tenants (code, name, currency, overdraft_limit)
       select 'PERFMT' || lpad(g::text, 2, '0'), 'perf small ' || g, 'CNY', 100 from generate_series(1, $1) g`,
      [SMALL_TENANTS],
    );
    await client.query(
      `insert into tenant_balances (tenant_id) select id from tenants where code like 'PERFMT%'`,
    );
    await client.query(
      `insert into balance_alert_settings (tenant_id, threshold, emails)
       select id, 100, array['perf@example.test'] from tenants where code like 'PERFMT%'`,
    );
    let step = performance.now();
    await client.query(
      `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
                         duration_seconds, billed_minutes, matched_prefix, country, rate, charge, hangup_cause)
       select $1, gen_random_uuid(), ts,
              case when g % 20 = 0 then null else ts + interval '3 seconds' end,
              ts + interval '70 seconds', '075586001234', '+8613800' || lpad((g % 100000)::text, 6, '0'),
              '8613800' || lpad((g % 100000)::text, 6, '0'),
              case when g % 20 = 0 then 0 else 61 end, case when g % 20 = 0 then 0 else 2 end,
              case when g % 20 = 0 then null else '86' end, case when g % 20 = 0 then null else '中国' end,
              case when g % 20 = 0 then null else 0.05 end, case when g % 20 = 0 then 0 else 0.1 end, 'NORMAL_CLEARING'
       from (select g, $2::timestamptz + g * interval '10.5 seconds' as ts from generate_series(1, $3::int) g) s`,
      [BIG, FIRST_START, PORTALBIG_CDRS],
    );
    console.log(`PORTALBIG 话单 ${PORTALBIG_CDRS} 条 ${ms(step)}s`);
    step = performance.now();
    await client.query(
      `insert into ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
       select $1, 'call_charge', -(0.05 + (g % 7) * 0.01), 'perf', null, 'perf:' || g,
              $2::timestamptz + g * interval '11 seconds', $2::timestamptz + g * interval '11 seconds'
       from generate_series(1, $3::int) g`,
      [BIG, FIRST_START, PORTALBIG_LEDGER],
    );
    const { rows: admins } = await client.query<{ id: string }>(
      'select id from admins limit 1',
    );
    await client.query(
      `insert into ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
       select $1, 'credit_recharge', 1000000000, 'perf recharge', $2, 'perf:recharge', $3::timestamptz, $3::timestamptz`,
      [BIG, admins[0]!.id, FIRST_START],
    );
    await client.query(
      `insert into ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
       select id, 'credit_recharge', 1000000, 'perf recharge', $1, 'perf:recharge', $2::timestamptz, $2::timestamptz
       from tenants where code like 'PERFMT%'`,
      [admins[0]!.id, FIRST_START],
    );
    await client.query(
      `update tenant_balances b set balance = coalesce((select sum(amount) from ledger_entries e where e.tenant_id = b.tenant_id), 0)
       where b.tenant_id = $1 or b.tenant_id in (select id from tenants where code like 'PERFMT%')`,
      [BIG],
    );
    await client.query('set session_replication_role = origin');
    console.log(`PORTALBIG 流水 ${PORTALBIG_LEDGER} 笔 ${ms(step)}s`);
    // 状态行：回填逻辑与迁移一致（灌数时触发器被跳过）。
    await client.query(
      `insert into balance_notice_state (tenant_id, low_active, suspended_active)
       select t.id, coalesce(s.threshold, 0) > 0 and b.balance < coalesce(s.threshold, 0), b.balance + t.overdraft_limit <= 0
       from tenants t join tenant_balances b on b.tenant_id = t.id left join balance_alert_settings s on s.tenant_id = t.id
       on conflict (tenant_id) do nothing`,
    );
    step = performance.now();
    await client.query('analyze');
    console.log(`analyze ${ms(step)}s`);
  } finally {
    client.release();
  }
  console.log(`setup 完成 ${ms(started)}s`);
}

interface Job {
  readonly tenantId: string;
  readonly callUuid: string;
}

/** 新灌一批可扣费的话单（接通、61 秒、0.05 元/分钟）。 */
async function freshCdrs(tenantIds: string[], count: number): Promise<Job[]> {
  const jobs: Job[] = [];
  const rows: unknown[][] = [];
  for (let index = 0; index < count; index++) {
    const callUuid = randomUUID();
    const tenantId = tenantIds[index % tenantIds.length]!;
    jobs.push({ tenantId, callUuid });
    rows.push([tenantId, callUuid, index]);
  }
  const client = await ownerPool.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
                         duration_seconds, billed_minutes, matched_prefix, country, rate, charge, hangup_cause)
       select j.tenant_id::uuid, j.call_uuid::uuid, ts, ts + interval '3 seconds', ts + interval '70 seconds',
              '075586001234', '+8613800138000', '8613800138000', 61, 2, '86', '中国', 0.05, 0.1, 'NORMAL_CLEARING'
       from (select value->>0 as tenant_id, value->>1 as call_uuid,
                    '2026-10-17T03:00:00Z'::timestamptz + (value->>2)::int * interval '10 milliseconds' as ts
             from jsonb_array_elements($1::jsonb)) j`,
      [JSON.stringify(rows)],
    );
    await client.query('set session_replication_role = origin');
  } finally {
    client.release();
  }
  return jobs;
}

interface Measurement {
  readonly scenario: string;
  readonly variant: 'before' | 'after';
  readonly round: number;
  readonly jobs: number;
  readonly concurrency: number;
  readonly wallMs: number;
  readonly perSecond: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly maxMs: number;
}

const percentile = (sorted: number[], p: number) =>
  sorted[
    Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  ]!;

async function runCharges(
  app: ReturnType<typeof connect>,
  jobs: Job[],
  concurrency: number,
) {
  const latencies: number[] = [];
  let next = 0;
  const started = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const index = next++;
        if (index >= jobs.length) return;
        const job = jobs[index]!;
        const t0 = performance.now();
        await withSystem(app.db, async (tx) => {
          await lockTenants(tx, [job.tenantId]);
          await chargeCall(tx, job);
        });
        latencies.push(performance.now() - t0);
      }
    }),
  );
  return { wallMs: performance.now() - started, latencies };
}

async function run() {
  const app = connect(appUrl, { max: 10 });
  const tenantIds = (
    await ownerPool.query<{ id: string; code: string }>(
      `select id, code from tenants where code = 'PORTALBIG' or code like 'PERFMT%' order by code`,
    )
  ).rows;
  const big = tenantIds.find((row) => row.code === 'PORTALBIG')!.id;
  const small = tenantIds
    .filter((row) => row.code !== 'PORTALBIG')
    .map((row) => row.id);
  const scenarios = [
    { name: 'PORTALBIG 单租户（租户锁串行）', tenants: [big], concurrency: 8 },
    { name: `${SMALL_TENANTS} 个租户轮流`, tenants: small, concurrency: 8 },
  ];
  const rounds = 5;
  const jobCount = 4000;
  const results: Measurement[] = [];
  for (const scenario of scenarios) {
    // 预热（不计）：两种状态各来一遍，让缓冲区和计划缓存稳定。
    for (const variant of ['before', 'after'] as const) {
      await setTrigger(variant);
      await runCharges(
        app,
        await freshCdrs(scenario.tenants, 800),
        scenario.concurrency,
      );
    }
    for (let round = 1; round <= rounds; round++) {
      // 每轮交替先后顺序，抵消缓存与后台写入的偏差。
      const order =
        round % 2 === 1
          ? (['before', 'after'] as const)
          : (['after', 'before'] as const);
      for (const variant of order) {
        await setTrigger(variant);
        const jobs = await freshCdrs(scenario.tenants, jobCount);
        const { wallMs, latencies } = await runCharges(
          app,
          jobs,
          scenario.concurrency,
        );
        latencies.sort((a, b) => a - b);
        const measurement: Measurement = {
          scenario: scenario.name,
          variant,
          round,
          jobs: jobCount,
          concurrency: scenario.concurrency,
          wallMs: Math.round(wallMs),
          perSecond: Math.round((jobCount / wallMs) * 1000 * 10) / 10,
          p50Ms: Math.round(percentile(latencies, 50) * 100) / 100,
          p95Ms: Math.round(percentile(latencies, 95) * 100) / 100,
          p99Ms: Math.round(percentile(latencies, 99) * 100) / 100,
          maxMs: Math.round(latencies[latencies.length - 1]! * 100) / 100,
        };
        results.push(measurement);
        console.log(JSON.stringify(measurement));
      }
    }
  }
  await setTrigger('after');
  await app.pool.end();

  // 触发器启用后，扣费路径上有没有真的产生通知？PORTALBIG 余额 10 亿，不越线：发件箱不应增加。
  const outbox = await ownerPool.query<{ n: number }>(
    `select count(*)::int as n from email_outbox where template like 'balance_%'`,
  );
  const summary = scenarios.map((scenario) => {
    const pick = (variant: 'before' | 'after') =>
      results.filter(
        (m) => m.scenario === scenario.name && m.variant === variant,
      );
    const median = (values: number[]) =>
      [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const before = pick('before');
    const after = pick('after');
    return {
      scenario: scenario.name,
      beforeMedianPerSecond: median(before.map((m) => m.perSecond)),
      afterMedianPerSecond: median(after.map((m) => m.perSecond)),
      beforeMedianP50Ms: median(before.map((m) => m.p50Ms)),
      afterMedianP50Ms: median(after.map((m) => m.p50Ms)),
      beforeMedianP95Ms: median(before.map((m) => m.p95Ms)),
      afterMedianP95Ms: median(after.map((m) => m.p95Ms)),
    };
  });
  const sizes = await ownerPool.query<Record<string, string | number>>(
    `select (select count(*) from cdrs where tenant_id = $1)::int as portalbig_cdrs,
            (select count(*) from ledger_entries where tenant_id = $1)::int as portalbig_ledger,
            version() as version, pg_size_pretty(pg_database_size(current_database())) as database_size`,
    [big],
  );
  const report = {
    host: {
      platform: platform(),
      release: release(),
      cpus: cpus().length,
      memoryBytes: totalmem(),
    },
    database: sizes.rows[0],
    balanceNoticesQueuedDuringRun: outbox.rows[0]!.n,
    rounds,
    jobsPerMeasurement: jobCount,
    summary,
    results,
  };
  if (outFile) await writeFile(outFile, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify(
      { summary, balanceNoticesQueuedDuringRun: outbox.rows[0]!.n },
      null,
      2,
    ),
  );
}

/** `before`：停用触发器（迁移之前的状态）；`after`：启用。 */
async function setTrigger(variant: 'before' | 'after') {
  await ownerPool.query(
    `alter table tenant_balances ${variant === 'before' ? 'disable' : 'enable'} trigger tenant_balances_notice`,
  );
}

try {
  if (mode === 'setup') await setup();
  else await run();
} finally {
  await ownerPool.end();
}
