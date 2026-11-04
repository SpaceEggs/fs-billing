import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import type { Job, PgBoss } from 'pg-boss';
import {
  connect,
  createRateVersion,
  ensureCdrPartitions,
  lockTenants,
  schema,
  withSystem,
  type Connection,
} from '@fs-billing/db';
import { rate } from '@fs-billing/rating';
import {
  connections,
  createTenant,
} from '../../../packages/db/test/support.js';
import { createWorker } from './app.js';
import { chargeJobs, chargeWorkOptions } from './charge.js';
import { DEFAULT_WORKER_CHARGE_BATCH_SIZE } from './config.js';
import {
  CHARGE_QUEUE,
  chargeJobId,
  chargeQueue,
  createBoss,
  installQueue,
} from './queue.js';

/**
 * 批处理扣费的正确性：一个坏任务不拖累同批、重投不重扣、同租户并发不死锁、
 * 两个 pg-boss 实例同时消费，以及排空期间 /authorize 不被业务池饿死。
 * 吞吐数字见 scripts/charge-queue-perf.ts 与 docs/perf/charge-queue.md。
 */

const { app: connection, owner } = connections();
const security = {
  secret: 'test-worker-key-123456',
  allowedIps: ['127.0.0.1'],
};
const tenantIds: string[] = [];
const logger = { error: vi.fn() };

interface WorkerSet {
  readonly boss: PgBoss;
  readonly business: Connection;
  readonly queue: Connection;
}

async function createWorkers(count: number): Promise<WorkerSet[]> {
  const workers: WorkerSet[] = [];
  for (let index = 0; index < count; index++) {
    const business = connect(inject('appUrl'), {
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    const queue = connect(inject('appUrl'), {
      max: 2,
      connectionTimeoutMillis: 5000,
    });
    const boss = createBoss(queue.db);
    boss.on('error', (error) => {
      errors.push(error);
    });
    await boss.start();
    workers.push({ boss, business, queue });
  }
  return workers;
}

const errors: unknown[] = [];

async function registerChargeWorkers(workers: readonly WorkerSet[]) {
  for (const worker of workers) {
    await worker.boss.work(
      CHARGE_QUEUE,
      chargeWorkOptions(DEFAULT_WORKER_CHARGE_BATCH_SIZE),
      (jobs) => chargeJobs(worker.business.db, jobs, logger),
    );
  }
}

async function stopWorkers(workers: readonly WorkerSet[]) {
  for (const worker of workers) {
    await worker.boss.offWork(CHARGE_QUEUE, { wait: true });
    await worker.boss.stop();
    await worker.queue.pool.end();
    await worker.business.pool.end();
  }
}

async function fixture(count: number) {
  const tenant = await createTenant(connection, 'CNY');
  tenantIds.push(tenant.id);
  await withSystem(connection.db, (tx) =>
    createRateVersion(
      tx,
      tenant.id,
      [
        {
          iso: '',
          description: '',
          prefix: '447',
          country: '英国',
          perMinute: rate('CNY', '0.0480'),
        },
      ],
      { effectiveFrom: new Date('2026-09-01T00:00:00Z') },
    ),
  );
  const uuids = Array.from({ length: count }, () => randomUUID());
  await withSystem(connection.db, async (tx) => {
    await lockTenants(tx, [tenant.id]);
    await tx.insert(schema.cdrs).values(
      uuids.map((callUuid, index) => {
        const startedAt = new Date(Date.now() - 3_600_000 - index * 1000);
        return {
          tenantId: tenant.id,
          callUuid,
          startedAt,
          answeredAt: new Date(startedAt.getTime() + 9000),
          endedAt: new Date(startedAt.getTime() + 199_000),
          caller: '075586001234',
          callee: '+447700900123',
          billingNumber: '447700900123',
          durationSeconds: 190,
          billedMinutes: '4',
          matchedPrefix: '447',
          country: '英国',
          rate: '0.048',
          charge: '0.192',
          hangupCause: 'NORMAL_CLEARING',
        };
      }),
    );
  });
  return { tenant, uuids };
}

async function enqueue(
  boss: PgBoss,
  tenantId: string,
  callUuids: readonly string[],
) {
  await withSystem(connection.db, async (tx) => {
    await lockTenants(tx, []);
    for (const callUuid of callUuids)
      await chargeQueue(boss).enqueue(tx, { tenantId, callUuid });
  });
}

async function jobCounts(ids: readonly string[]) {
  const { rows } = await owner.pool.query<{
    completed: number;
    failed: number;
    pending: number;
  }>(
    `select (count(*) filter (where state = 'completed'))::int as completed,
            (count(*) filter (where state = 'failed'))::int as failed,
            (count(*) filter (where state in ('created', 'retry', 'active')))::int as pending
       from pgboss.job where name = $1 and id = any($2::uuid[])`,
    [CHARGE_QUEUE, ids],
  );
  return rows[0]!;
}

async function waitForJobs(
  ids: readonly string[],
  completed: number,
  failed = 0,
  timeout = 30_000,
) {
  await expect
    .poll(async () => jobCounts(ids), { timeout, interval: 100 })
    .toEqual({ completed, failed, pending: 0 });
}

async function ledgerState(tenantId: string) {
  const { rows } = await owner.pool.query<{
    entries: number;
    keys: number;
    total: string;
    balance: string;
    balanced: boolean;
  }>(
    `select count(*)::int as entries,
            count(distinct idempotency_key)::int as keys,
            coalesce(sum(amount), 0)::text as total,
            (select balance::text from tenant_balances where tenant_id = $1) as balance,
            (select balance from tenant_balances where tenant_id = $1)
              = coalesce(sum(amount), 0) as balanced
       from ledger_entries where tenant_id = $1`,
    [tenantId],
  );
  return rows[0]!;
}

beforeAll(async () => {
  await ensureCdrPartitions(connection.db, { moment: new Date() });
  await ensureCdrPartitions(connection.db, {
    moment: new Date(Date.now() - 3_600_000),
  });
  await installQueue(owner);
  await owner.pool.query('delete from pgboss.job where name = $1', [
    CHARGE_QUEUE,
  ]);
});

afterAll(async () => {
  await owner.pool.query(
    `delete from pgboss.job where name = $1 and data->>'tenantId' = any($2::text[])`,
    [CHARGE_QUEUE, tenantIds],
  );
});

describe('扣费批处理', () => {
  it('同批一个毒任务只重试自己，其他任务各扣一次', async () => {
    const { tenant, uuids } = await fixture(8);
    const poison = randomUUID();
    const workers = await createWorkers(1);
    try {
      await enqueue(workers[0]!.boss, tenant.id, [...uuids, poison]);
      await registerChargeWorkers(workers);
      const ids = [...uuids, poison].map((uuid) => chargeJobId(uuid));
      await waitForJobs(ids, uuids.length, 1, 60_000);
    } finally {
      await stopWorkers(workers);
    }

    const healthy = await owner.pool.query<{
      n: number;
      retry_values: number;
      max_retry: number;
    }>(
      `select count(*)::int as n,
              count(distinct retry_count)::int as retry_values,
              max(retry_count)::int as max_retry
         from pgboss.job where id = any($1::uuid[])`,
      [uuids.map((uuid) => chargeJobId(uuid))],
    );
    expect(healthy.rows).toEqual([
      { n: uuids.length, retry_values: 1, max_retry: 0 },
    ]);
    expect(
      (
        await owner.pool.query(
          'select state, retry_count from pgboss.job where id = $1',
          [chargeJobId(poison)],
        )
      ).rows,
    ).toEqual([{ state: 'failed', retry_count: 3 }]);
    expect(await ledgerState(tenant.id)).toMatchObject({
      entries: uuids.length,
      keys: uuids.length,
      total: '-1.536',
      balance: '-1.536',
      balanced: true,
    });
    expect(logger.error).toHaveBeenCalled();
  }, 120_000);

  it('同一任务重投后读回同一笔流水，不重复扣费', async () => {
    const { tenant, uuids } = await fixture(1);
    const [callUuid] = uuids;
    const id = chargeJobId(callUuid!);
    const workers = await createWorkers(1);
    try {
      await enqueue(workers[0]!.boss, tenant.id, [callUuid!]);
      await registerChargeWorkers(workers);
      await waitForJobs([id], 1, 0, 30_000);
      const first = await owner.pool.query<{ completed_on: Date | null }>(
        'select completed_on from pgboss.job where id = $1',
        [id],
      );
      expect(first.rows[0]?.completed_on).not.toBeNull();

      // 模拟「流水已提交但任务确认丢失」后的重投：同一条任务回到可领取状态。
      await owner.pool.query(
        `update pgboss.job
            set state = 'created', started_on = null, completed_on = null, output = null
          where id = $1`,
        [id],
      );
      await expect
        .poll(
          async () =>
            (
              await owner.pool.query<{ state: string }>(
                'select state from pgboss.job where id = $1',
                [id],
              )
            ).rows[0]?.state,
          { timeout: 30_000, interval: 100 },
        )
        .toBe('completed');
      expect(
        (
          await owner.pool.query<{ completed_on: Date | null }>(
            'select completed_on from pgboss.job where id = $1',
            [id],
          )
        ).rows[0]?.completed_on,
      ).toBeInstanceOf(Date);
    } finally {
      await stopWorkers(workers);
    }
    expect(await ledgerState(tenant.id)).toMatchObject({
      entries: 1,
      keys: 1,
      total: '-0.192',
      balance: '-0.192',
      balanced: true,
    });
    expect(errors).toEqual([]);
  }, 90_000);

  it('同一租户并发扣费与多个租户一起排空，无死锁且余额等于流水合计', async () => {
    const main = await fixture(24);
    const others = await Promise.all(
      Array.from({ length: 4 }, () => fixture(8)),
    );
    const all = [main, ...others];
    const jobs = all.flatMap(({ tenant, uuids }) =>
      uuids.map((callUuid) => ({ tenantId: tenant.id, callUuid })),
    );
    const workers = await createWorkers(2);
    try {
      for (const { tenant, uuids } of all)
        await enqueue(workers[0]!.boss, tenant.id, uuids);
      await registerChargeWorkers(workers);
      await waitForJobs(
        jobs.map((job) => chargeJobId(job.callUuid)),
        jobs.length,
        0,
        120_000,
      );
    } finally {
      await stopWorkers(workers);
    }

    const jobState = await owner.pool.query<{
      n: number;
      retry_values: number;
      max_retry: number;
    }>(
      `select count(*)::int as n,
              count(distinct retry_count)::int as retry_values,
              max(retry_count)::int as max_retry
         from pgboss.job where id = any($1::uuid[])`,
      [jobs.map((job) => chargeJobId(job.callUuid))],
    );
    expect(jobState.rows).toEqual([
      { n: jobs.length, retry_values: 1, max_retry: 0 },
    ]);
    for (const { tenant, uuids } of all) {
      expect(await ledgerState(tenant.id)).toMatchObject({
        entries: uuids.length,
        keys: uuids.length,
        balanced: true,
      });
    }
    expect(errors).toEqual([]);
  }, 180_000);

  it('两个 pg-boss 实例同时消费，每个任务恰好执行一次', async () => {
    const all = await Promise.all(Array.from({ length: 4 }, () => fixture(25)));
    const jobs = all.flatMap(({ tenant, uuids }) =>
      uuids.map((callUuid) => ({ tenantId: tenant.id, callUuid })),
    );
    const seen = new Map<string, Set<string>>();
    const workers = await createWorkers(2);
    try {
      for (const { tenant, uuids } of all)
        await enqueue(workers[0]!.boss, tenant.id, uuids);
      for (const [index, worker] of workers.entries()) {
        await worker.boss.work(
          CHARGE_QUEUE,
          chargeWorkOptions(DEFAULT_WORKER_CHARGE_BATCH_SIZE),
          async (batch: Job<unknown>[]) => {
            for (const job of batch) {
              const instances = seen.get(job.id) ?? new Set<string>();
              instances.add(`worker-${index}`);
              seen.set(job.id, instances);
            }
            return chargeJobs(worker.business.db, batch, logger);
          },
        );
      }
      const ids = jobs.map((job) => chargeJobId(job.callUuid));
      await waitForJobs(ids, jobs.length, 0, 120_000);
    } finally {
      await stopWorkers(workers);
    }

    expect([...seen.keys()].sort()).toEqual(
      jobs.map((job) => chargeJobId(job.callUuid)).sort(),
    );
    expect([...seen.values()].every((instances) => instances.size === 1)).toBe(
      true,
    );
    expect(
      new Set([...seen.values()].flatMap((instances) => [...instances])).size,
    ).toBe(2);
    for (const { tenant, uuids } of all) {
      expect(await ledgerState(tenant.id)).toMatchObject({
        entries: uuids.length,
        keys: uuids.length,
        balanced: true,
      });
    }
    expect(errors).toEqual([]);
  }, 180_000);

  it('扣费队列排空期间 /authorize 仍然可用', async () => {
    const { tenant, uuids } = await fixture(120);
    const workers = await createWorkers(1);
    const app = createWorker({
      db: workers[0]!.business.db,
      queue: chargeQueue(workers[0]!.boss),
      security,
    });
    try {
      await enqueue(workers[0]!.boss, tenant.id, uuids);
      await registerChargeWorkers(workers);
      const latencies: number[] = [];
      const authorize = (async () => {
        for (let index = 0; index < 25; index++) {
          const started = performance.now();
          const response = await app.inject({
            method: 'POST',
            url: '/authorize',
            headers: {
              'content-type': 'application/json',
              'x-billing-key': security.secret,
            },
            payload: {
              tenant: tenant.code,
              callee: '447700900123',
              dialedNumber: '+447700900123',
              uuid: randomUUID(),
            },
          });
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject({ allowed: true });
          latencies.push(performance.now() - started);
        }
      })();
      await Promise.all([
        waitForJobs(
          uuids.map((uuid) => chargeJobId(uuid)),
          uuids.length,
          0,
          120_000,
        ),
        authorize,
      ]);
      latencies.sort((left, right) => left - right);
      const p95 = latencies[Math.ceil((latencies.length * 95) / 100) - 1]!;
      expect(p95).toBeLessThan(2000);
    } finally {
      await app.close();
      await stopWorkers(workers);
    }
    expect(await ledgerState(tenant.id)).toMatchObject({
      entries: uuids.length,
      balanced: true,
    });
  }, 180_000);
});
