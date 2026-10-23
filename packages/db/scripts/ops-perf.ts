import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { beijingTime, parseRateCsv } from '@fs-billing/rating';
import { connect } from '../src/client.js';
import {
  assignUnassigned,
  previewAssignment,
  type AssignmentPreview,
} from '../src/unassigned/index.js';
import {
  deleteCdrMonths,
  listCdrDeletionMonths,
} from '../src/cdr-deletion/index.js';
import { lockTenants, withAdmin, withSystem } from '../src/client.js';
import { createRateVersion } from '../src/rates.js';
import {
  generateStatement,
  reconcileTenantStatements,
} from '../src/statements/index.js';
import { RATES_CSV } from '../src/seed.js';

// 阶段 8 PR 1 的耗时：分配 N 条话单、删除一个月话单（PORTALBIG 的 2026-09）、
// 未归属列表在 10 万行下的分页与分组、操作日志在 100 万行下带筛选的查询。
// 会写库：只允许在 fs_billing_perf 的克隆库上运行（不是 fs_billing_perf 本身）。
//   CREATE DATABASE fs_billing_perf_p8pr1 TEMPLATE fs_billing_perf;  然后对它执行 pnpm db:migrate
//   PERF_OWNER_URL=postgresql://fs_billing:…@127.0.0.1:5432/fs_billing_perf_p8pr1 \
//   PERF_APP_URL=postgresql://fs_billing_app:…@127.0.0.1:5432/fs_billing_perf_p8pr1 \
//   pnpm --filter @fs-billing/db exec tsx scripts/ops-perf.ts
const ownerUrl = z.url().parse(process.env.PERF_OWNER_URL);
const appUrl = z.url().parse(process.env.PERF_APP_URL);
for (const [url, user] of [
  [ownerUrl, 'fs_billing'],
  [appUrl, 'fs_billing_app'],
] as const) {
  const parsed = new URL(url);
  assert(parsed.pathname.startsWith('/fs_billing_perf_'), '只允许克隆库');
  assert.notEqual(parsed.pathname, '/fs_billing_perf');
  assert.equal(parsed.username, user);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname));
}

const owner = connect(ownerUrl, { max: 4 });
const app = connect(appUrl, { max: 6 });
const ms = (started: number) => (performance.now() - started).toFixed(1);
const sleep = (n: number) => new Promise((r) => setTimeout(r, n));

try {
  const tenantId = (
    await owner.pool.query<{ id: string }>(
      `select id from tenants where code = 'PORTALBIG'`,
    )
  ).rows[0]!.id;
  const admin = (
    await owner.pool.query<{ id: string; name: string }>(
      `select id, name from admins order by name limit 1`,
    )
  ).rows[0]!;
  const actor = { id: admin.id, name: admin.name };
  console.log(
    `# 克隆库 ${new URL(ownerUrl).pathname.slice(1)}，租户 PORTALBIG`,
  );

  // 租户锁探针：循环拿同一把租户锁并记录等待时间，最大值就是被持锁事务挡住的最长排队时间。
  async function withProbe<T>(run: () => Promise<T>) {
    let stop = false;
    const waits: number[] = [];
    const probe = (async () => {
      while (!stop) {
        const started = performance.now();
        await withSystem(app.db, (tx) => lockTenants(tx, [tenantId]));
        waits.push(performance.now() - started);
        await sleep(20);
      }
    })();
    await sleep(100);
    const started = performance.now();
    const result = await run();
    const elapsed = performance.now() - started;
    stop = true;
    await probe;
    return {
      result,
      elapsed,
      probeMax: Math.max(...waits),
      probeCount: waits.length,
    };
  }

  // ---- 分配 ----
  const { rows: versionRows } = await owner.pool.query(
    `select 1 from rate_versions where tenant_id = $1`,
    [tenantId],
  );
  if (versionRows.length === 0) {
    const parsed = parseRateCsv(RATES_CSV, 'CNY');
    assert(parsed.ok);
    await withAdmin(owner.db, (tx) =>
      createRateVersion(tx, tenantId, parsed.entries, {
        effectiveFrom: beijingTime('2025-01-01 00:00:00'),
      }),
    );
    console.log('# PORTALBIG 没有费率表，写入种子费率表（2025-01-01 起生效）');
  }

  const callees = [
    '8613800138000',
    '447700900123',
    '85291234567',
    '14155550123',
    '6591234567',
    '442071234567',
    '8613912345678',
    '81345678901',
  ];
  async function insertUnassigned(tag: string, count: number) {
    await owner.pool.query(
      `insert into unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, answered_at, ended_at, caller, callee,
         billing_number, duration_seconds, hangup_cause)
       select $1, gen_random_uuid(), '租户不存在',
         t, t + interval '3 seconds', t + interval '3 seconds' + (s || ' seconds')::interval,
         '075586001234', '+' || c, c, s, 'NORMAL_CLEARING'
       from (
         select '2026-10-02 10:00:00+08'::timestamptz + (g * interval '7 seconds') as t,
           20 + (g * 97) % 515 as s,
           (array[${callees.map((c) => `'${c}'`).join(',')}])[1 + g % ${callees.length}] as c
         from generate_series(1, $2::int) as g) x`,
      [tag, count],
    );
  }
  const expectedOf = (preview: AssignmentPreview) => ({
    assignable: preview.assignable,
    noRate: preview.noRate.count,
    chargeTotal: preview.chargeTotal,
  });

  for (const n of [326, 500, 2000, 5000]) {
    const tag = `PERF${n}`;
    await insertUnassigned(tag, n);
    const selection = { group: { tag } } as const;
    const balanceBefore = (
      await owner.pool.query<{ b: string }>(
        `select balance::text as b from tenant_balances where tenant_id = $1`,
        [tenantId],
      )
    ).rows[0]!.b;
    for (let run = 1; run <= 3; run++) {
      const started = performance.now();
      const preview = await previewAssignment(app.db, {
        tenantId,
        selection,
        maxRows: 10_000,
      });
      console.log(
        `preview N=${n} run ${run}: ${ms(started)} ms assignable=${preview.assignable} chargeTotal=${preview.chargeTotal} noRate=${preview.noRate.count}`,
      );
    }
    const preview = await previewAssignment(app.db, {
      tenantId,
      selection,
      maxRows: 10_000,
    });
    const measured = await withProbe(() =>
      assignUnassigned(app.db, {
        actor,
        tenantId,
        selection,
        idempotencyKey: `perf-${n}-${Date.now()}`,
        expected: expectedOf(preview),
        maxRows: 10_000,
      }),
    );
    console.log(
      `assign N=${n}: ${measured.elapsed.toFixed(1)} ms total, ${(measured.elapsed / n).toFixed(2)} ms/row, 租户锁探针最长排队 ${measured.probeMax.toFixed(1)} ms（${measured.probeCount} 次探测） assigned=${measured.result.assigned} chargeTotal=${measured.result.chargeTotal} balance ${balanceBefore} -> ${measured.result.balanceAfter}`,
    );
  }

  // ---- 删除一个月 ----
  const generateStarted = performance.now();
  for (const month of ['2026-08-01', '2026-09-01'])
    await withSystem(app.db, (tx) => generateStatement(tx, tenantId, month), {
      isolationLevel: 'repeatable read',
    });
  console.log(
    `generate statements 2026-08, 2026-09: ${ms(generateStarted)} ms`,
  );
  const reconcileStarted = performance.now();
  const reconciled = await withSystem(
    app.db,
    (tx) => reconcileTenantStatements(tx, tenantId),
    { isolationLevel: 'repeatable read' },
  );
  console.log(
    `reconcile PORTALBIG: ${ms(reconcileStarted)} ms ${JSON.stringify(reconciled.statements.map((s) => [s.month, s.status]))}`,
  );
  for (let run = 1; run <= 3; run++) {
    const started = performance.now();
    const months = await listCdrDeletionMonths(app.db, {
      tenantId,
      year: 2026,
    });
    console.log(
      `list deletion months 2026 run ${run}: ${ms(started)} ms ${JSON.stringify(months.slice(7, 9).map((m) => [m.month, m.state, m.cdrCount, m.blockedReasons]))}`,
    );
  }
  interface Snapshot {
    ledger: number;
    ledger_sum: string;
    balance: string;
    sept_cdrs: number;
  }
  const before = (
    await owner.pool.query<Snapshot>(
      `select (select count(*)::int from ledger_entries where tenant_id = $1) as ledger,
              (select sum(amount)::text from ledger_entries where tenant_id = $1) as ledger_sum,
              (select balance::text from tenant_balances where tenant_id = $1) as balance,
              (select count(*)::int from cdrs where tenant_id = $1 and coalesce(answered_at, started_at) >= '2026-08-31 16:00+00' and coalesce(answered_at, started_at) < '2026-09-30 16:00+00') as sept_cdrs`,
      [tenantId],
    )
  ).rows[0]!;
  const deleted = await withProbe(() =>
    deleteCdrMonths(app.db, {
      actor,
      tenantId,
      fromMonth: '2026-09',
      toMonth: '2026-09',
      tenantCode: 'PORTALBIG',
      expectedCount: before.sept_cdrs,
    }),
  );
  console.log(
    `delete 2026-09 (${before.sept_cdrs} cdrs): ${deleted.elapsed.toFixed(1)} ms total, 租户锁探针最长排队 ${deleted.probeMax.toFixed(1)} ms（${deleted.probeCount} 次探测） deleted=${deleted.result.total}`,
  );
  const after = (
    await owner.pool.query<Snapshot>(
      `select (select count(*)::int from ledger_entries where tenant_id = $1) as ledger,
              (select sum(amount)::text from ledger_entries where tenant_id = $1) as ledger_sum,
              (select balance::text from tenant_balances where tenant_id = $1) as balance,
              (select count(*)::int from cdrs where tenant_id = $1 and coalesce(answered_at, started_at) >= '2026-08-31 16:00+00' and coalesce(answered_at, started_at) < '2026-09-30 16:00+00') as sept_cdrs`,
      [tenantId],
    )
  ).rows[0]!;
  console.log(`before ${JSON.stringify(before)}`);
  console.log(`after  ${JSON.stringify(after)}`);
  assert.equal(after.ledger, before.ledger);
  assert.equal(after.ledger_sum, before.ledger_sum);
  assert.equal(after.balance, before.balance);
  assert.equal(after.sept_cdrs, 0);

  // ---- 列表与日志的查询形状（迁移 0018 的索引） ----
  const timeQuery = async (
    label: string,
    text: string,
    values: unknown[] = [],
  ) => {
    for (let run = 1; run <= 3; run++) {
      const started = performance.now();
      const result = await app.db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
        return tx.execute(
          sql.raw(
            text.replace(/\$(\d+)/g, (_, i: string) =>
              String(values[Number(i) - 1]),
            ),
          ),
        );
      });
      console.log(
        `${label} run ${run}: ${ms(started)} ms rows=${result.rows.length}`,
      );
    }
  };
  const existing = (
    await owner.pool.query<{ n: number }>(
      `select count(*)::int as n from unassigned_cdrs where status = 'pending'`,
    )
  ).rows[0]!.n;
  const fill = Math.max(0, 100_000 - existing);
  const fillStarted = performance.now();
  await owner.pool.query(
    `insert into unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, answered_at, ended_at, caller, callee,
       billing_number, duration_seconds, hangup_cause)
     select 'TAG' || lpad((g % 40)::text, 2, '0'), gen_random_uuid(), '租户不存在',
       '2026-09-01 00:00:00+08'::timestamptz + (g * interval '23 seconds'),
       '2026-09-01 00:00:03+08'::timestamptz + (g * interval '23 seconds'),
       '2026-09-01 00:01:03+08'::timestamptz + (g * interval '23 seconds'),
       '075586001234', '+8613800138000', '8613800138000', 60, 'NORMAL_CLEARING'
     from generate_series(1, $1::int) g`,
    [fill],
  );
  await owner.pool.query('analyze unassigned_cdrs');
  console.log(
    `# unassigned_cdrs 补到 100000 行 pending（写入 ${fill} 行 ${ms(fillStarted)} ms）`,
  );
  await timeQuery(
    'unassigned groups (pending, by tag)',
    `select tenant_tag, count(*)::int as n from unassigned_cdrs where status = 'pending' group by 1 order by 2 desc, 1`,
  );
  await timeQuery(
    'unassigned page 1 of 50 (pending, newest first)',
    `select id, tenant_tag, coalesce(answered_at, started_at) as t from unassigned_cdrs where status = 'pending'
     order by coalesce(answered_at, started_at) desc, id limit 50 offset 0`,
  );
  await timeQuery(
    'unassigned page 1000 of 50 (offset 49950)',
    `select id, tenant_tag, coalesce(answered_at, started_at) as t from unassigned_cdrs where status = 'pending'
     order by coalesce(answered_at, started_at) desc, id limit 50 offset 49950`,
  );
  await timeQuery(
    'unassigned count (pending)',
    `select count(*)::int as n from unassigned_cdrs where status = 'pending'`,
  );
  await timeQuery(
    'unassigned page of one tag',
    `select id, coalesce(answered_at, started_at) as t from unassigned_cdrs where status = 'pending' and tenant_tag = 'TAG07'
     order by coalesce(answered_at, started_at) desc, id limit 50`,
  );

  const logFill = 1_000_000;
  const logStarted = performance.now();
  await owner.pool.query(
    `insert into operation_logs (admin_id, tenant_id, action, target, details, created_at)
     select (select id from admins order by id limit 1 offset (g % 2)),
       (select id from tenants order by id limit 1 offset (g % 17)),
       (array['tenant_edit','balance_topup','rate_entry_edit','rate_import','receivable_confirm','statement_regenerate',
              'unassigned_assign','cdr_delete','reset_password','balance_adjustment'])[1 + g % 10],
       'x', '{}'::jsonb,
       '2025-10-23 00:00:00+08'::timestamptz + (g * interval '31 seconds')
     from generate_series(1, $1::int) g`,
    [logFill],
  );
  await owner.pool.query('analyze operation_logs');
  console.log(`# operation_logs 写入 ${logFill} 行 ${ms(logStarted)} ms`);
  const tenant = (
    await owner.pool.query<{ id: string }>(
      `select id from tenants where code = 'PORTALBIG'`,
    )
  ).rows[0]!.id;
  await timeQuery(
    'logs newest 50 (last 30 days)',
    `select id, created_at, action from operation_logs where created_at >= '2026-09-23' and created_at < '2026-10-24'
     order by created_at desc, id limit 50`,
  );
  await timeQuery(
    'logs count (last 30 days)',
    `select count(*)::int from operation_logs where created_at >= '2026-09-23' and created_at < '2026-10-24'`,
  );
  await timeQuery(
    'logs newest 50 (last 30 days + tenant)',
    `select id, created_at from operation_logs where created_at >= '2026-09-23' and created_at < '2026-10-24' and tenant_id = '$1'
     order by created_at desc, id limit 50`,
    [tenant],
  );
  await timeQuery(
    'logs count (last 30 days + tenant)',
    `select count(*)::int from operation_logs where created_at >= '2026-09-23' and created_at < '2026-10-24' and tenant_id = '$1'`,
    [tenant],
  );
  await timeQuery(
    'logs newest 50 (last 30 days + action set)',
    `select id, created_at from operation_logs where created_at >= '2026-09-23' and created_at < '2026-10-24' and action in ('cdr_delete','unassigned_assign')
     order by created_at desc, id limit 50`,
  );
  await timeQuery(
    'logs newest 50 (last 30 days + admin, no admin index)',
    `select id, created_at from operation_logs where created_at >= '2026-09-23' and created_at < '2026-10-24' and admin_id = '$1'
     order by created_at desc, id limit 50`,
    [admin.id],
  );
  await timeQuery(
    'logs newest 50 (whole year, deep page offset 100000)',
    `select id, created_at from operation_logs order by created_at desc, id limit 50 offset 100000`,
  );
} finally {
  await owner.pool.end();
  await app.pool.end();
}
