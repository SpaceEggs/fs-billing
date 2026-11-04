import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { FastifyBaseLogger } from 'fastify';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import {
  connect,
  createRateVersion,
  ensureCdrPartitions,
  lockTenants,
  withSystem,
  type Connection,
} from '@fs-billing/db';
import { rate } from '@fs-billing/rating';
import { migrateDatabase } from '../../../packages/db/src/migrate.js';
import { chargeCdr, chargeJobs, chargeWorkOptions } from '../src/charge.js';
import { DEFAULT_WORKER_CHARGE_BATCH_SIZE } from '../src/config.js';
import {
  CHARGE_QUEUE,
  chargeJobId,
  chargeQueue,
  createBoss,
  installQueue,
} from '../src/queue.js';

/**
 * 扣费队列吞吐（阶段 10 缺陷：charge 队列按 pg-boss 默认一次取 1 个、每 2 秒轮询）。
 *
 * 在一个专用的 `fs_billing_perf_charge_queue` 库上灌入真实 cdrs 行，用生产 `chargeCdr`、
 * 生产队列和同一套工作选项跑真实 pg-boss；可指定 1 或 2 个实例，每次实例有独立业务池与队列池。
 * 排空时间从注册 work 之前开始算，到本批任务全部 completed 且没有 created/retry/active 为止。
 *
 *   setup：删除并重建性能库、迁移、安装队列
 *   run  ：--variant before|after --instances 1|2 --jobs N --out file.json
 *
 * `before` 是修复前的行为（batchSize 1、无 burst、任务抛错即整批失败）；`after` 用
 * `chargeWorkOptions` 与默认批大小。只允许回环地址和 `fs_billing_perf_*` 库。
 */

for (const candidate of ['../../.env', '.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

const PERF_DATABASE = 'fs_billing_perf_charge_queue';
const mode = z.enum(['setup', 'run']).parse(process.argv[2]);
const ownerUrl =
  process.env.PERF_OWNER_URL ??
  withDatabase(z.url().parse(process.env.DATABASE_URL), PERF_DATABASE);
const appUrl =
  process.env.PERF_APP_URL ??
  withDatabase(z.url().parse(process.env.APP_DATABASE_URL), PERF_DATABASE);

for (const [url, user] of [
  [ownerUrl, 'fs_billing'],
  [appUrl, 'fs_billing_app'],
] as const) {
  const parsed = new URL(url);
  assert(
    /^fs_billing_perf_[a-z0-9_]+$/.test(parsed.pathname.slice(1)),
    '只允许 fs_billing_perf_* 性能库',
  );
  assert.equal(parsed.username, user);
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname),
    '只允许本机回环地址',
  );
}
assert.equal(
  new URL(ownerUrl).pathname,
  new URL(appUrl).pathname,
  'owner 与 app 必须指向同一个性能库',
);

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
}

/** 只用于读日志；失败由最后的 completed/failed 计数判定。 */
const logger = {
  error: (fields: unknown, message?: string) => console.error(message, fields),
} satisfies Pick<FastifyBaseLogger, 'error'>;

async function setup() {
  const started = performance.now();
  const database = new URL(ownerUrl).pathname.slice(1);
  const adminUrl = new URL(ownerUrl);
  adminUrl.pathname = '/postgres';
  const admin = connect(adminUrl.toString(), { max: 1 });
  try {
    await admin.pool.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin.pool.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.pool.end();
  }
  const authUrl = new URL(appUrl);
  authUrl.username = 'fs_billing_auth';
  await migrateDatabase({
    DATABASE_URL: ownerUrl,
    APP_DATABASE_URL: appUrl,
    AUTH_DATABASE_URL: authUrl.toString(),
  });
  const owner = connect(ownerUrl, { max: 2 });
  try {
    await installQueue(owner);
  } finally {
    await owner.pool.end();
  }
  console.log(
    `性能库 ${database} 已重建（${((performance.now() - started) / 1000).toFixed(1)}s）`,
  );
}

interface PerfTenant {
  readonly id: string;
  readonly code: string;
}

interface Counts {
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
}

async function jobCounts(
  pool: Connection['pool'],
  ids: readonly string[],
): Promise<Counts> {
  const { rows } = await pool.query<Counts>(
    `select (count(*) filter (where state = 'completed'))::int as completed,
            (count(*) filter (where state = 'failed'))::int as failed,
            (count(*) filter (where state in ('created', 'retry', 'active')))::int as pending
       from pgboss.job where name = $1 and id = any($2::uuid[])`,
    [CHARGE_QUEUE, ids],
  );
  return rows[0]!;
}

async function createTenants(
  pool: Connection['pool'],
  count: number,
): Promise<PerfTenant[]> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 8).toUpperCase();
  const tenants: PerfTenant[] = [];
  for (let index = 0; index < count; index++) {
    const code = `PERFC${suffix}${String(index).padStart(2, '0')}`;
    const { rows } = await pool.query<{ id: string }>(
      `insert into tenants (code, name, currency, overdraft_limit)
       values ($1, $2, 'CNY', 100) returning id`,
      [code, `扣费队列压测 ${code}`],
    );
    tenants.push({ id: rows[0]!.id, code });
  }
  return tenants;
}

async function createRates(
  owner: ReturnType<typeof connect>,
  tenants: readonly PerfTenant[],
) {
  const effectiveFrom = new Date(Date.now() - 86_400_000);
  for (const tenant of tenants) {
    await withSystem(owner.db, async (tx) => {
      await lockTenants(tx, [tenant.id]);
      await createRateVersion(
        tx,
        tenant.id,
        [
          {
            iso: '',
            description: '',
            prefix: '447',
            country: '英国',
            perMinute: rate('CNY', '0.0500'),
          },
        ],
        { effectiveFrom },
      );
    });
  }
}

async function insertCdrs(
  pool: Connection['pool'],
  jobs: readonly { tenantId: string; callUuid: string }[],
) {
  const client = await pool.connect();
  try {
    await client.query('set session_replication_role = replica');
    await client.query(
      `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at,
                         caller, callee, billing_number, duration_seconds, billed_minutes,
                         matched_prefix, country, rate, charge, hangup_cause)
       select (j.value->>'tenantId')::uuid,
              (j.value->>'callUuid')::uuid,
              ts, ts + interval '9 seconds', ts + interval '199 seconds',
              '075586001234', '+447700900123', '447700900123',
              190, 4, '447', '英国', 0.05, 0.192, 'NORMAL_CLEARING'
         from jsonb_array_elements($1::jsonb) with ordinality j(value, ordinal)
         cross join lateral (
           select now() - interval '10 minutes' + (j.ordinal % 300) * interval '1 second' as ts
         ) times`,
      [JSON.stringify(jobs)],
    );
  } finally {
    await client.query('set session_replication_role = origin');
    client.release();
  }
}

interface WorkerInstance {
  readonly boss: ReturnType<typeof createBoss>;
  readonly business: ReturnType<typeof connect>;
  readonly queue: ReturnType<typeof connect>;
}

async function run() {
  const variant = z
    .enum(['before', 'after'])
    .parse(argument('--variant') ?? 'after');
  const instances = z.coerce
    .number()
    .int()
    .min(1)
    .max(4)
    .parse(argument('--instances') ?? process.env.PERF_INSTANCES ?? 1);
  const jobCount = z.coerce
    .number()
    .int()
    .min(1)
    .max(100_000)
    .parse(argument('--jobs') ?? process.env.PERF_JOBS ?? 2000);
  const batchSize = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(argument('--batch-size') ?? DEFAULT_WORKER_CHARGE_BATCH_SIZE);
  const outputFile = argument('--out');

  const owner = connect(ownerUrl, { max: 4 });
  const workers: WorkerInstance[] = [];
  const errors: unknown[] = [];
  try {
    const tenants = await createTenants(owner.pool, 6);
    await createRates(owner, tenants);
    await ensureCdrPartitions(owner.db, {
      moment: new Date(Date.now() - 3_600_000),
    });

    const jobs = Array.from({ length: jobCount }, (_, index) => ({
      tenantId: tenants[index % tenants.length]!.id,
      callUuid: randomUUID(),
    }));
    await insertCdrs(owner.pool, jobs);

    for (let index = 0; index < instances; index++) {
      const business = connect(appUrl, {
        max: 10,
        connectionTimeoutMillis: 5000,
        poolName: `perf.charge.business.${index}`,
      });
      const queue = connect(appUrl, {
        max: 2,
        connectionTimeoutMillis: 5000,
        poolName: `perf.charge.queue.${index}`,
      });
      const boss = createBoss(queue.db);
      boss.on('error', (error) => errors.push(error));
      await boss.start();
      workers.push({ boss, business, queue });
    }

    // 用生产入队路径（chargeQueue + 调用方事务）把 N 个真实扣费任务写进 pg-boss。
    await withSystem(workers[0]!.business.db, async (tx) => {
      await lockTenants(tx, []);
      for (const job of jobs)
        await chargeQueue(workers[0]!.boss).enqueue(tx, job);
    });
    const ids = jobs.map((job) => chargeJobId(job.callUuid));

    const started = performance.now();
    for (const worker of workers) {
      if (variant === 'before') {
        // 修复前的行为：pg-boss 默认 batchSize 1、2 秒轮询，任务抛错让整批失败。
        await worker.boss.work(
          CHARGE_QUEUE,
          { batchSize: 1 },
          async (batch: Job<unknown>[]) => {
            for (const job of batch)
              await chargeCdr(worker.business.db, job.data);
          },
        );
      } else {
        await worker.boss.work(
          CHARGE_QUEUE,
          chargeWorkOptions(batchSize),
          (batch) => chargeJobs(worker.business.db, batch, logger),
        );
      }
    }

    const deadline = Date.now() + 30 * 60_000;
    let counts = await jobCounts(owner.pool, ids);
    while (counts.pending > 0) {
      if (Date.now() > deadline) {
        throw new Error(
          `队列在 30 分钟内未排空：${JSON.stringify(counts)}，错误 ${errors.length} 个`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      counts = await jobCounts(owner.pool, ids);
    }
    const wallMs = performance.now() - started;
    assert.equal(counts.completed, jobCount, '本批任务没有全部完成');
    assert.equal(counts.failed, 0, '本批任务出现失败');
    assert.equal(errors.length, 0, 'pg-boss 报告错误');

    const tenantIds = tenants.map((tenant) => tenant.id);
    const keys = jobs.map((job) => `call:${job.callUuid}`);
    const { rows: ledger } = await owner.pool.query<{
      entries: number;
      distinct_keys: number;
      total: string;
      balanced: boolean;
    }>(
      `select count(*)::int as entries,
              count(distinct idempotency_key)::int as distinct_keys,
              coalesce(sum(amount), 0)::text as total,
              (select coalesce(sum(balance), 0)
                 from tenant_balances where tenant_id = any($1::uuid[]))
                = coalesce(sum(amount), 0) as balanced
         from ledger_entries
        where tenant_id = any($1::uuid[]) and idempotency_key = any($2::text[])`,
      [tenantIds, keys],
    );
    const accounting = ledger[0]!;
    assert.equal(accounting.entries, jobCount, '流水条数与任务数不一致');
    assert.equal(accounting.distinct_keys, jobCount, '幂等键重复');
    assert.equal(accounting.balanced, true, '余额合计不等于流水合计');

    const report = {
      measuredAt: new Date().toISOString(),
      variant,
      instances,
      jobs: jobCount,
      batchSize: variant === 'after' ? batchSize : 1,
      burstWhenBatchFull: variant === 'after',
      perJobResults: variant === 'after',
      tenants: tenants.length,
      wallMs: Math.round(wallMs),
      perSecond: Math.round((jobCount / wallMs) * 1000 * 10) / 10,
      ledgerEntries: accounting.entries,
      ledgerTotal: accounting.total,
      balanceEqualsLedger: accounting.balanced,
      host: {
        platform: platform(),
        release: release(),
        cpus: cpus().length,
        memoryBytes: totalmem(),
      },
      database: (
        await owner.pool.query<{ version: string }>('select version()')
      ).rows[0]!.version,
    };
    if (outputFile) {
      await writeFile(outputFile, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const worker of workers) {
      await worker.boss.offWork(CHARGE_QUEUE, { wait: true });
      await worker.boss.stop();
      await worker.queue.pool.end();
      await worker.business.pool.end();
    }
    await owner.pool.end();
  }
}

try {
  if (mode === 'setup') await setup();
  else await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
