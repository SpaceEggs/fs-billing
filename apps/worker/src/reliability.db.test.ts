import type {} from '../../../packages/db/test/global-setup.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, inject, it } from 'vitest';
import { z } from 'zod';
import {
  connect,
  createRateVersion,
  lockTenants,
  withSystem,
} from '@fs-billing/db';
import { cdrResponseSchema } from '@fs-billing/shared';
import { rate } from '@fs-billing/rating';
import {
  connections,
  createTenant,
} from '../../../packages/db/test/support.js';
import { createWorker } from './app.js';
import { chargeCdr } from './charge.js';
import {
  CHARGE_QUEUE,
  RECONCILE_QUEUE,
  chargeQueue,
  createBoss,
  installQueue,
} from './queue.js';
import { reconcileCharges, startReconciliation } from './reconcile.js';

const { app: connection, owner } = connections();
const queueConnection = connect(inject('appUrl'), {
  max: 2,
  connectionTimeoutMillis: 1000,
});
const boss = createBoss(queueConnection.db);
const security = {
  secret: 'test-worker-key-123456',
  allowedIps: ['127.0.0.1'],
};
const worker = createWorker({
  db: connection.db,
  queue: chargeQueue(boss),
  security,
});
const template = z
  .object({ variables: z.record(z.string(), z.unknown()) })
  .parse(
    JSON.parse(
      await readFile(
        new URL(
          '../../../freeswitch/examples/sample-cdr.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  );
const options = { minAgeMinutes: 5, alertAttempts: 2 };
function body(
  code: string,
  uuid: string,
  overrides: Record<string, unknown> = {},
) {
  return JSON.stringify({
    variables: {
      ...template.variables,
      billing_tenant: code,
      uuid,
      ...overrides,
    },
  });
}
const post = (payload: string, app = worker) =>
  app.inject({
    method: 'POST',
    url: '/cdr',
    headers: {
      'content-type': 'application/json',
      'x-billing-key': security.secret,
    },
    payload,
  });
async function fixture() {
  const tenant = await createTenant(connection, 'CNY');
  await withSystem(connection.db, (tx) =>
    createRateVersion(
      tx,
      tenant.id,
      [{ prefix: '447', country: '英国', perMinute: rate('CNY', '0.0480') }],
      { effectiveFrom: new Date('2026-09-01T00:00:00Z') },
    ),
  );
  return tenant;
}
async function age(tenantId: string, uuid: string) {
  await withSystem(owner.db, async (tx) => {
    await lockTenants(tx, [tenantId]);
    await tx.execute(sql`UPDATE cdrs SET received_at = now() - interval '1 hour',
      reconciled_at = CASE WHEN reconciled_at IS NULL THEN NULL ELSE now() - interval '1 hour' END
      WHERE call_uuid = ${uuid}`);
  });
}
async function fetchCall(uuid: string) {
  const job = (
    await boss.fetch<unknown>(CHARGE_QUEUE, { batchSize: 1000 })
  ).find(
    (job) =>
      z.object({ callUuid: z.string() }).parse(job.data).callUuid === uuid,
  );
  if (!job) throw new Error(`没有可执行的任务 ${uuid}`);
  return job;
}
async function exhaust(uuid: string, run: (data: unknown) => Promise<void>) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const job = await fetchCall(uuid);
    await expect(run(job.data)).rejects.toThrow();
    await boss.fail(CHARGE_QUEUE, job.id, { message: '模拟持续故障' });
  }
  const { rows } = await owner.pool.query(
    "select state, retry_count from pgboss.job where name = $1 and data->>'callUuid' = $2 order by created_on desc limit 1",
    [CHARGE_QUEUE, uuid],
  );
  expect(rows).toEqual([{ state: 'failed', retry_count: 3 }]);
}
beforeAll(async () => {
  await installQueue(owner);
  await boss.start();
});
afterAll(async () => {
  await worker.close();
  await boss.stop();
  await queueConnection.pool.end();
});

it('启动后的 50 个并发推送在 10 秒内全部保存，独立小队列池不等待业务连接', async () => {
  const tenant = await fixture();
  const business = connect(inject('appUrl'), {
    max: 10,
    connectionTimeoutMillis: 1000,
  });
  const cold = createBoss(queueConnection.db);
  const app = createWorker({
    db: business.db,
    queue: chargeQueue(cold),
    security,
  });
  const uuids = Array.from({ length: 50 }, () => randomUUID());
  try {
    await cold.start();
    const responses = await Promise.all(
      uuids.map((uuid) => post(body(tenant.code, uuid), app)),
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(50).fill(200));
    expect(
      responses.map((r) => cdrResponseSchema.parse(r.json()).status),
    ).toEqual(Array(50).fill('queued'));
    const { rows } = await owner.pool.query(
      `select
      (select count(*)::int from cdrs where call_uuid = any($1::uuid[])) as cdrs,
      (select count(*)::int from raw_cdrs where payload->'variables'->>'uuid' = any($1::text[])) as raw,
      (select count(*)::int from pgboss.job where name = $2 and data->>'callUuid' = any($1::text[])) as jobs`,
      [uuids, CHARGE_QUEUE],
    );
    expect(rows).toEqual([{ cdrs: 50, raw: 50, jobs: 50 }]);
  } finally {
    await app.close();
    await cold.stop();
    await business.pool.end();
  }
}, 10000);

it('pg-boss 冷缓存且唯一业务连接被入库事务占用时，推送仍原子保存话单和任务', async () => {
  const tenant = await fixture();
  const uuid = randomUUID();
  const business = connect(inject('appUrl'), {
    max: 1,
    connectionTimeoutMillis: 1000,
  });
  // 不调用 start，避免预热队列缓存；send 首次读取元数据必须另借连接。
  const cold = createBoss(queueConnection.db);
  const app = createWorker({
    db: business.db,
    queue: chargeQueue(cold),
    security,
  });
  try {
    const response = await post(body(tenant.code, uuid), app);
    expect(response.statusCode).toBe(200);
    expect(cdrResponseSchema.parse(response.json()).status).toBe('queued');
    const { rows } = await owner.pool.query(
      `select
      (select count(*)::int from cdrs where call_uuid = $1) as cdrs,
      (select count(*)::int from raw_cdrs where payload->'variables'->>'uuid' = $1::text) as raw,
      (select count(*)::int from pgboss.job where name = $2 and data->>'callUuid' = $1::text) as jobs`,
      [uuid, CHARGE_QUEUE],
    );
    expect(rows).toEqual([{ cdrs: 1, raw: 1, jobs: 1 }]);
  } finally {
    await app.close();
    await cold.stop();
    await business.pool.end();
  }
}, 5000);

it('重试耗尽后对账重新入队，并发/重复对账与重复扣费只产生一笔流水', async () => {
  const tenant = await fixture();
  const uuid = randomUUID();
  expect((await post(body(tenant.code, uuid))).statusCode).toBe(200);
  await exhaust(uuid, () => Promise.reject(new Error('模拟任务进程失败')));
  // 未到宽限期不补投。
  await reconcileCharges(connection.db, boss, options);
  await age(tenant.id, uuid);
  await Promise.all([
    reconcileCharges(connection.db, boss, options),
    reconcileCharges(connection.db, boss, options),
  ]);
  const job = await fetchCall(uuid);
  await Promise.all([
    chargeCdr(connection.db, job.data),
    chargeCdr(connection.db, job.data),
  ]);
  await boss.complete(CHARGE_QUEUE, job.id);
  await age(tenant.id, uuid);
  await reconcileCharges(connection.db, boss, options);
  expect(
    (
      await owner.pool.query(
        'select reconcile_attempts from cdrs where call_uuid = $1',
        [uuid],
      )
    ).rows,
  ).toEqual([{ reconcile_attempts: 1 }]);
  expect(
    (
      await owner.pool.query(
        'select amount::text from ledger_entries where idempotency_key = $1',
        [`call:${uuid}`],
      )
    ).rows,
  ).toEqual([{ amount: '-0.192' }]);
  expect(
    (
      await owner.pool.query(
        'select balance::text from tenant_balances where tenant_id = $1',
        [tenant.id],
      )
    ).rows,
  ).toEqual([{ balance: '-0.192' }]);
  expect(
    (
      await owner.pool.query(
        "select count(*)::int as n from pgboss.job where name = $1 and data->>'callUuid' = $2",
        [CHARGE_QUEUE, uuid],
      )
    ).rows,
  ).toEqual([{ n: 2 }]);
});

it('真实扣费持续失败，补投次数持久保存且告警只写一次，恢复后仍可收费', async () => {
  const tenant = await fixture();
  const uuid = randomUUID();
  await post(body(tenant.code, uuid));
  await owner.pool.query('revoke insert on ledger_entries from fs_billing_app');
  try {
    for (let cycle = 0; cycle <= options.alertAttempts; cycle++) {
      await exhaust(uuid, (data) => chargeCdr(connection.db, data));
      await age(tenant.id, uuid);
      await reconcileCharges(connection.db, boss, options);
    }
    await age(tenant.id, uuid);
    await Promise.all([
      reconcileCharges(connection.db, boss, options),
      reconcileCharges(connection.db, boss, options),
    ]);
    expect(
      (
        await owner.pool.query(
          'select description from system_alerts where description = $1',
          [`${uuid}: 扣费对账持续失败，请人工处理`],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await owner.pool.query(
          'select reconcile_attempts, reconcile_alerted from cdrs where call_uuid = $1',
          [uuid],
        )
      ).rows,
    ).toEqual([{ reconcile_attempts: 3, reconcile_alerted: true }]);
  } finally {
    await owner.pool.query('grant insert on ledger_entries to fs_billing_app');
  }
  const job = await fetchCall(uuid);
  await chargeCdr(connection.db, job.data);
  await boss.complete(CHARGE_QUEUE, job.id);
  expect(
    (
      await owner.pool.query(
        'select amount::text from ledger_entries where idempotency_key = $1',
        [`call:${uuid}`],
      )
    ).rows,
  ).toEqual([{ amount: '-0.192' }]);
});

it.each([
  {},
  { variables: { uuid: 'broken' } },
  null,
  { variables: { uuid: randomUUID(), billsec: '-1' } },
])('校验失败 %j 保存为可定位原文的 pending，不产生扣费', async (input) => {
  const payload = JSON.stringify(input);
  const response = await post(payload);
  expect(response.statusCode).toBe(200);
  expect(cdrResponseSchema.parse(response.json()).status).toBe('unassigned');
  const { rows } = await owner.pool.query<{
    status: string;
    reason: string;
    started_at: Date | null;
    ended_at: Date | null;
    body: string;
    cdrs: number;
    jobs: number;
    charges: number;
  }>(
    `select u.status, u.reason, u.started_at, u.ended_at, r.body,
    (select count(*)::int from cdrs where call_uuid = u.call_uuid) as cdrs,
    (select count(*)::int from pgboss.job where name = $2 and data->>'callUuid' = u.call_uuid::text) as jobs,
    (select count(*)::int from ledger_entries where idempotency_key = 'call:' || u.call_uuid::text) as charges
    from unassigned_cdrs u join raw_cdrs r on (r.id, r.received_at) = (u.raw_id, u.raw_received_at) where r.id = $1`,
    [cdrResponseSchema.parse(response.json()).rawId, CHARGE_QUEUE],
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]?.reason).toContain('话单校验失败');
  expect(rows).toMatchObject([
    {
      status: 'pending',
      started_at: null,
      ended_at: null,
      body: payload,
      cdrs: 0,
      jobs: 0,
      charges: 0,
    },
  ]);
  expect(
    (
      await owner.pool.query(
        'select kind from system_alerts where description like $1',
        [`${cdrResponseSchema.parse(response.json()).rawId}:%`],
      )
    ).rows,
  ).toEqual([{ kind: 'cdr_failed' }]);
});

it('无效时间但有效 UUID 的并发推送共用 UUID 闸门，修正重推也不绕过人工处理', async () => {
  const tenant = await fixture();
  const uuid = randomUUID();
  const payload = body(tenant.code, uuid, { end_epoch: 'bad' });
  const responses = await Promise.all([post(payload), post(payload)]);
  expect(
    responses.map((r) => cdrResponseSchema.parse(r.json()).status).sort(),
  ).toEqual(['duplicate', 'unassigned']);
  expect(
    cdrResponseSchema.parse((await post(body(tenant.code, uuid))).json())
      .status,
  ).toBe('duplicate');
  expect(
    (
      await owner.pool.query(
        'select count(*)::int as n from unassigned_cdrs where call_uuid = $1',
        [uuid],
      )
    ).rows,
  ).toEqual([{ n: 1 }]);
  expect(
    (
      await owner.pool.query(
        'select count(*)::int as n from ledger_entries where idempotency_key = $1',
        [`call:${uuid}`],
      )
    ).rows,
  ).toEqual([{ n: 0 }]);
});

it('/authorize 缺失/错误密钥返回 401，白名单外返回 403', async () => {
  const payload = {
    tenant: 'ABC001',
    callee: '447700900123',
    uuid: randomUUID(),
  };
  for (const key of [undefined, 'bad-key']) {
    expect(
      (
        await worker.inject({
          method: 'POST',
          url: '/authorize',
          payload,
          headers: key ? { 'x-billing-key': key } : {},
        })
      ).statusCode,
    ).toBe(401);
  }
  expect(
    (
      await worker.inject({
        method: 'POST',
        url: '/authorize',
        payload,
        headers: { 'x-billing-key': security.secret },
        remoteAddress: '192.0.2.1',
      })
    ).statusCode,
  ).toBe(403);
});

it('对账调度每分钟执行真实任务', async () => {
  await startReconciliation(boss, connection.db, options);
  expect(await boss.getSchedules(RECONCILE_QUEUE)).toMatchObject([
    { cron: '* * * * *', timezone: 'Asia/Shanghai' },
  ]);
  const id = await boss.send(RECONCILE_QUEUE);
  await expect
    .poll(
      async () =>
        (
          await owner.pool.query<{ state: string }>(
            'select state from pgboss.job where name = $1 and id = $2',
            [RECONCILE_QUEUE, id],
          )
        ).rows[0]?.state,
      { timeout: 10000 },
    )
    .toBe('completed');
});
