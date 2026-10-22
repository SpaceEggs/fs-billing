import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { connect } from '../src/client.js';
import { computeStatement } from '../src/statements/compute.js';

// 月账单取数在 PORTALBIG（fs_billing_perf）上的耗时。只读：fs_billing_app 身份、read only 事务，不改任何表。
//   PERF_APP_DATABASE_URL=postgresql://fs_billing_app:…@127.0.0.1:5432/fs_billing_perf \
//   pnpm --filter @fs-billing/db exec tsx scripts/statements-perf.ts
const url = z.url().parse(process.env.PERF_APP_DATABASE_URL);
assert.equal(new URL(url).pathname, '/fs_billing_perf');
assert.equal(new URL(url).username, 'fs_billing_app');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname));
const asOf = new Date(
  z.iso
    .datetime({ offset: true })
    .parse(process.env.PERF_AS_OF ?? '2026-10-17T04:00:00Z'),
);

const { db, pool } = connect(url);
try {
  const id = await db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
      return (
        await tx.execute<{ id: string }>(
          sql`select id from tenants where code = 'PORTALBIG'`,
        )
      ).rows[0]!.id;
    },
    { accessMode: 'read only' },
  );
  const measure = async (
    label: string,
    month: string,
    options: Parameters<typeof computeStatement>[3],
    runs: number,
  ) => {
    for (let run = 1; run <= runs; run++) {
      const started = performance.now();
      const result = await db.transaction(
        async (tx) => {
          await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
          return computeStatement(tx, id, month, options);
        },
        { accessMode: 'read only', isolationLevel: 'repeatable read' },
      );
      const elapsed = performance.now() - started;
      console.log(
        `${label} run ${run}: ${elapsed.toFixed(1)} ms calls=${result.calls} charges=${result.callCharges} gap=${result.breakdownGap} countries=${result.countries.length} days=${result.days.length}`,
      );
    }
  };
  await measure(
    'closed 2026-09 (opening from ledger)',
    '2026-09-01',
    undefined,
    3,
  );
  await measure(
    'closed 2026-08 (opening from ledger)',
    '2026-08-01',
    undefined,
    2,
  );
  await measure(
    `in-progress 2026-10 as of ${asOf.toISOString()} (opening from balance anchor)`,
    '2026-10-01',
    { asOf, opening: 'balance' },
    3,
  );
  const openings = await Promise.all(
    (['ledger', 'balance'] as const).map((opening) =>
      db.transaction(
        async (tx) => {
          await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
          return computeStatement(tx, id, '2026-10-01', { asOf, opening });
        },
        { accessMode: 'read only', isolationLevel: 'repeatable read' },
      ),
    ),
  );
  console.log(
    `opening of 2026-10 from ledger = ${openings[0]!.openingBalance}, from balance anchor = ${openings[1]!.openingBalance}, equal = ${openings[0]!.openingBalance === openings[1]!.openingBalance}`,
  );
  for (let run = 1; run <= 2; run++) {
    const started = performance.now();
    const monthly = await db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
        return tx.execute(sql`
          select date_trunc('month', occurred_at at time zone 'Asia/Shanghai')::date as month, sum(amount) as amount
          from ledger_entries where tenant_id = ${id}::uuid group by 1`);
      },
      { accessMode: 'read only' },
    );
    console.log(
      `reconcile monthly scan run ${run}: ${(performance.now() - started).toFixed(1)} ms months=${monthly.rows.length}`,
    );
  }
} finally {
  await pool.end();
}
