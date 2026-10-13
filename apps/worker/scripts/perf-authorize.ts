import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  createRateVersion,
  connect,
  lockTenants,
  schema,
  withSystem,
} from '@fs-billing/db';
import { rate } from '@fs-billing/rating';
import { createWorker } from '../src/app.js';
import { workerEnvironmentSchema } from '../src/config.js';

const config = workerEnvironmentSchema.parse(process.env);
const connection = connect(config.APP_DATABASE_URL);
const id = randomUUID();
const code = `PERF${id.replaceAll('-', '').toUpperCase()}`;
const app = createWorker({
  db: connection.db,
  queue: { enqueue: () => Promise.reject(new Error('授权压测不接收话单')) },
  security: { secret: config.WORKER_SHARED_KEY, allowedIps: ['127.0.0.1'] },
});
try {
  await withSystem(connection.db, async (tx) => {
    await lockTenants(tx, [id]);
    await tx.insert(schema.tenants).values({
      id,
      code,
      name: '授权压测 500 条费率',
      currency: 'CNY',
      overdraftLimit: '100',
    });
    await createRateVersion(
      tx,
      id,
      Array.from({ length: 500 }, (_, index) => ({
        prefix: String(1000 + index),
        country: `压测 ${index}`,
        perMinute: rate('CNY', '0.1000'),
      })),
    );
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const times: number[] = [];
  for (let index = 0; index < 1000; index++) {
    const start = performance.now();
    const response = await fetch(`${address}/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-billing-key': config.WORKER_SHARED_KEY,
      },
      body: JSON.stringify({
        tenant: code,
        callee: '149912345678',
        uuid: randomUUID(),
      }),
    });
    const result: unknown = await response.json();
    if (
      response.status !== 200 ||
      JSON.stringify(result) !==
        JSON.stringify({ allowed: true, maxSeconds: 14400 })
    ) {
      throw new Error(
        `授权压测失败：HTTP ${response.status} ${JSON.stringify(result)}`,
      );
    }
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil((times.length * 95) / 100) - 1]!;
  console.info(
    JSON.stringify({
      entries: 500,
      requests: times.length,
      p95Ms: p95,
      maxMs: times.at(-1),
      passed: p95 < 50,
    }),
  );
  if (p95 >= 50) process.exitCode = 1;
} finally {
  await app.close();
  // 已生效费率不可删除，停用专用压测租户，保留可检查的压测数据。
  await withSystem(connection.db, async (tx) => {
    await lockTenants(tx, [id]);
    await tx
      .update(schema.tenants)
      .set({ status: 'disabled' })
      .where(eq(schema.tenants.id, id));
  });
  await connection.pool.end();
}
