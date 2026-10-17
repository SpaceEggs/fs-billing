import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { decimal } from '@fs-billing/rating';
import { z } from 'zod';
import { withAdmin } from '../src/client.js';
import { migrateDatabase } from '../src/migrate.js';
import { readTenantUsageOverview } from '../src/usage.js';
import * as schema from '../src/schema.js';

const asOf = new Date(
  z.iso
    .datetime({ offset: true })
    .parse(process.env.PERF_AS_OF ?? '2026-10-17T04:00:00Z'),
);
const tenantIds = Array.from(
  { length: 20 },
  (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
);
const administrator = '00000000-0000-4000-9000-000000000001';
const mode = z.enum(['seed', 'explain', 'all']).parse(process.argv[2] ?? 'all');
const output = resolve(
  process.argv[3] ??
    resolve(import.meta.dirname, '../../../docs/perf/overview-explain'),
);
const ownerUrl = z.url().parse(process.env.PERF_DATABASE_URL);
const appUrl = z.url().parse(process.env.PERF_APP_DATABASE_URL);
for (const value of [ownerUrl, appUrl]) {
  const url = new URL(value);
  assert.equal(
    url.pathname,
    '/fs_overview_perf',
    'Use the dedicated fs_overview_perf database',
  );
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Use local PostgreSQL',
  );
}
assert.equal(new URL(appUrl).username, 'fs_billing_app');
const owner = new pg.Pool({ connectionString: ownerUrl, max: 1 });
const app = new pg.Pool({ connectionString: appUrl, max: 1 });

function expectedOverview(callCount: number) {
  const dayMs = 86_400_000;
  const beijingDay = new Date(asOf.getTime() + 8 * 3_600_000)
    .toISOString()
    .slice(0, 10);
  const todayStart = Date.parse(`${beijingDay}T00:00:00+08:00`);
  const monthStart = Date.parse(`${beijingDay.slice(0, 7)}-01T00:00:00+08:00`);
  const monthEnd = new Date(monthStart + 8 * 3_600_000);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setTime(monthEnd.getTime() - 8 * 3_600_000);
  let answeredCalls = 0;
  let unansweredCalls = 0;
  let monthSpend = decimal('0');
  const daily = Array.from({ length: 30 }, () => decimal('0'));
  for (let i = 1; i <= callCount; i++) {
    const started =
      asOf.getTime() - 60 * dayMs + (60 * dayMs * (i - 1)) / callCount;
    if (i % 10 >= 3) {
      const answered = started + 1_000;
      if (answered >= monthStart && answered < monthEnd.getTime())
        answeredCalls++;
      const posted = started + 2_000;
      if (posted >= monthStart && posted < monthEnd.getTime())
        monthSpend = monthSpend.plus('0.02');
      const day = Math.floor((posted - todayStart) / dayMs) + 29;
      if (day >= 0 && day < 30)
        daily[day] = (daily[day] ?? decimal('0')).plus('0.02');
    } else if (started >= monthStart && started < monthEnd.getTime()) {
      unansweredCalls++;
    }
  }
  return { answeredCalls, unansweredCalls, monthSpend, daily };
}

async function seed() {
  await migrateDatabase({ DATABASE_URL: ownerUrl, APP_DATABASE_URL: appUrl });
  const count = await owner.query<{ count: string }>(
    'select count(*) from tenants',
  );
  assert.equal(
    count.rows[0]?.count,
    '0',
    'Seeding requires an empty tenant table',
  );
  await owner.query("select set_config('app.scope', 'admin', false)");
  await owner.query(
    "select cdr_ensure_partitions($1::timestamptz - interval '60 days', 3)",
    [asOf],
  );
  await owner.query(
    `insert into auth."user" (id, name, email) values ('overview-perf', 'Overview benchmark', 'overview-perf@example.invalid')`,
  );
  await owner.query(
    'insert into admins (id, auth_user_id, name) values ($1, $2, $3)',
    [administrator, 'overview-perf', 'Overview benchmark'],
  );
  for (const [n, tenantId] of tenantIds.entries()) {
    await owner.query(
      "insert into tenants (id, code, name, currency, overdraft_limit) values ($1, $2, $3, 'CNY', 100)",
      [tenantId, `PERF${n + 1}`, `Performance tenant ${n + 1}`],
    );
    const callCount = n === 0 ? 2_000_000 : 1_000;
    for (let first = 1; first <= callCount; first += 50_000) {
      const last = Math.min(first + 49_999, callCount);
      await owner.query(
        `
        insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at,
          caller, callee, billing_number, duration_seconds, billed_minutes,
          matched_prefix, country, rate, charge, hangup_cause, unverified)
        select $1::uuid, md5($1::text || ':' || i::text)::uuid,
          started, case when i % 10 >= 3 then started + interval '1 second' end,
          started + interval '62 seconds', '1000', '8613800138000', '8613800138000',
          case when i % 10 >= 3 then 61 else 0 end,
          case when i % 10 >= 3 then 2 else 0 end,
          case when i % 10 >= 3 then '86' end,
          case when i % 10 >= 3 then 'CN' end,
          case when i % 10 >= 3 then 0.01 end,
          case when i % 10 >= 3 then 0.02 else 0 end,
          case when i % 10 < 2 then 'NO_ANSWER' when i % 10 = 2 then 'CALL_REJECTED' else 'NORMAL_CLEARING' end,
          i % 10 = 2
        from generate_series($2::int, $3::int) i
        cross join lateral (select $4::timestamptz - interval '60 days' + interval '60 days' * ((i - 1)::double precision / $5::int) as started) t
      `,
        [tenantId, first, last, asOf, callCount],
      );
      for (let chargeFirst = first; chargeFirst <= last; chargeFirst += 5_000) {
        await owner.query('begin');
        try {
          await owner.query('select lock_tenants(array[$1::uuid])', [tenantId]);
          await owner.query(
            `
            insert into ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
            select $1::uuid, 'call_charge', -0.02, 'perf:' || i,
              $4::timestamptz - interval '60 days' + interval '60 days' * ((i - 1)::double precision / $5::int) + interval '2 seconds'
            from generate_series($2::int, $3::int) i where i % 10 >= 3
          `,
            [
              tenantId,
              chargeFirst,
              Math.min(chargeFirst + 4_999, last),
              asOf,
              callCount,
            ],
          );
          await owner.query('commit');
        } catch (error) {
          await owner.query('rollback');
          throw error;
        }
      }
      process.stderr.write(
        `${JSON.stringify({ event: 'seed.progress', tenant: n + 1, cdrs: last, callCount })}\n`,
      );
    }
    await owner.query('begin');
    try {
      await owner.query('select lock_tenants(array[$1::uuid])', [tenantId]);
      await owner.query(
        `insert into ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key)
        select $1::uuid, 'adjustment', case when i % 2 = 0 then 5 else -3 end,
          'Performance fixture adjustment', $2::uuid, 'adjustment:' || i from generate_series(1, 20) i`,
        [tenantId, administrator],
      );
      await owner.query('commit');
    } catch (error) {
      await owner.query('rollback');
      throw error;
    }
  }
  await owner.query('vacuum (analyze)');
}

async function explain() {
  await mkdir(output, { recursive: true });
  const metadata = await owner.query<
    Record<string, string>
  >(`select version(), current_setting('shared_buffers') as shared_buffers,
    current_setting('work_mem') as work_mem, current_setting('random_page_cost') as random_page_cost,
    current_setting('max_parallel_workers_per_gather') as max_parallel_workers_per_gather,
    current_setting('effective_cache_size') as effective_cache_size,
    current_setting('jit') as jit, current_setting('plan_cache_mode') as plan_cache_mode,
    current_setting('enable_partition_pruning') as enable_partition_pruning,
    current_setting('track_io_timing') as track_io_timing`);
  assert.match(String(metadata.rows[0]?.version), /^PostgreSQL 17\./);
  const sizes = await owner.query<{
    tenant_id: string;
    cdrs: number;
    unanswered: number;
    rejected: number;
    first_started: Date;
    last_started: Date;
  }>(`select tenant_id, count(*)::int as cdrs,
    count(*) filter (where answered_at is null)::int as unanswered,
    count(*) filter (where hangup_cause = 'CALL_REJECTED')::int as rejected,
    min(started_at) as first_started, max(started_at) as last_started
    from cdrs group by tenant_id order by tenant_id`);
  assert.equal(sizes.rowCount, 20);
  assert.equal(sizes.rows[0]?.cdrs, 2_000_000);
  for (const row of sizes.rows.slice(1)) assert.equal(row.cdrs, 1_000);
  const ledger = await owner.query(
    `select kind, count(*)::int as count from ledger_entries group by kind order by kind`,
  );
  const indexes =
    await owner.query(`select p.relname as parent_index, c.relname as partition_index,
    pg_get_indexdef(c.oid) as definition from pg_inherits i
    join pg_class p on p.oid = i.inhparent join pg_class c on c.oid = i.inhrelid
    where p.relname in ('cdrs_tenant_started_at', 'cdrs_tenant_answered_at') order by 1, 2`);
  await writeFile(
    resolve(output, 'fixture.json'),
    JSON.stringify(
      {
        asOf,
        metadata: metadata.rows,
        sizes: sizes.rows,
        ledger: ledger.rows,
        indexes: indexes.rows,
      },
      null,
      2,
    ),
  );
  const results = [];
  const expected = new Map([
    ['large', expectedOverview(2_000_000)],
    ['small', expectedOverview(1_000)],
  ]);
  for (const round of [1, 2, 3, 4, 5, 0]) {
    for (const [label, tenantId] of [
      ['large', tenantIds[0]],
      ['small', tenantIds[1]],
    ]) {
      assert(tenantId);
      let captured: { query: string; params: unknown[] } | undefined;
      let overviewStatements = 0;
      const settings: string[] = [];
      const db = drizzle(app, {
        schema,
        logger: {
          logQuery(query, params) {
            if (query.includes('with instant as')) {
              captured = { query, params };
              overviewStatements++;
            } else if (query.startsWith('set local ')) settings.push(query);
          },
        },
      });
      const started = performance.now();
      const overview = await withAdmin(db, (tx) =>
        readTenantUsageOverview(tx, tenantId, round === 0 ? undefined : asOf),
      );
      const callMs = performance.now() - started;
      if (round !== 0) {
        const fixture = expected.get(label ?? '');
        assert(fixture);
        assert.equal(overview.answeredCalls, fixture.answeredCalls);
        assert.equal(overview.unansweredCalls, fixture.unansweredCalls);
        assert.equal(
          Number(overview.monthCallMinutes),
          fixture.answeredCalls * 2,
        );
        assert.equal(
          decimal(overview.monthSpend).toFixed(),
          fixture.monthSpend.toFixed(),
        );
        assert.deepEqual(
          overview.daily.map((day) => decimal(day.spend).toFixed()),
          fixture.daily.map((value) => value.toFixed()),
        );
        assert.equal(
          decimal(overview.dailyTotal).toFixed(),
          fixture.daily.reduce((a, b) => a.plus(b), decimal('0')).toFixed(),
        );
      } else {
        // 造数按 asOf 当天生成，生产形式只在同一个北京自然日内与固定时间可比。
        const beijingDay = (value: Date) =>
          new Date(value.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
        assert.equal(
          beijingDay(new Date(overview.asOf)),
          beijingDay(asOf),
          'Run the production round on the PERF_AS_OF Beijing day',
        );
      }
      assert(
        captured,
        'readTenantUsageOverview must execute one captured SQL query',
      );
      assert.equal(overviewStatements, 1);
      const plans: Record<string, string> = {};
      const client = await app.connect();
      try {
        await client.query('begin read only');
        await client.query("select set_config('app.scope', 'admin', true)");
        for (const setting of settings) await client.query(setting);
        if (round === 1 && label === 'large') {
          const identity = await client.query(`select current_user,
            current_setting('app.scope') as scope,
            current_setting('transaction_read_only') as transaction_read_only,
            current_setting('jit') as jit,
            rolbypassrls, rolsuper from pg_roles where rolname = current_user`);
          plans.identity = JSON.stringify(identity.rows, null, 2);
        }
        for (const [name, options] of [
          ['timed', 'ANALYZE, BUFFERS'],
          ['untimed', 'ANALYZE, BUFFERS, TIMING OFF'],
        ] as const) {
          const plan = await client.query<{ 'QUERY PLAN': string }>(
            `EXPLAIN (${options}) ${captured.query}`,
            captured.params,
          );
          plans[name] = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
        }
      } finally {
        await client.query('rollback');
        client.release();
      }
      const executionMs = (text = '') =>
        Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1]);
      if (plans.identity)
        await writeFile(resolve(output, 'app-identity.json'), plans.identity);
      if (round <= 1) {
        const stem = `${label}-${round === 0 ? 'production' : round}`;
        await writeFile(resolve(output, `${stem}.txt`), `${plans.timed}\n`);
        await writeFile(
          resolve(output, `${stem}.query.json`),
          JSON.stringify({ ...captured, settings, overview }, null, 2),
        );
      }
      results.push({
        tenant: label,
        round,
        callMs: Number(callMs.toFixed(3)),
        untimedExecutionMs: executionMs(plans.untimed),
        timedExecutionMs: executionMs(plans.timed),
      });
      process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
    }
  }
  await writeFile(
    resolve(output, 'timings.json'),
    JSON.stringify(results, null, 2),
  );
}

try {
  if (mode !== 'explain') await seed();
  if (mode !== 'seed') await explain();
} finally {
  await Promise.all([owner.end(), app.end()]);
}
