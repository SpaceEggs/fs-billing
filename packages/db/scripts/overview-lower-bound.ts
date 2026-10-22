import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

/**
 * 概况查询「接通月份」CTE 有无 31 天 started_at 下界的对照（阶段 6 决定 40，PR 7）。
 * 只读：fs_billing_app 身份、READ ONLY 事务、每次 ROLLBACK，不改性能库的数据。
 *
 *   PERF_APP_DATABASE_URL=postgres://fs_billing_app:...@127.0.0.1:5432/fs_billing_perf_pr3_uuid_v4 \
 *   pnpm --filter @fs-billing/db exec tsx scripts/overview-lower-bound.ts <输出目录>
 *
 * 两种语句：`answered` 只跑接通月份 CTE；`overview` 是完整概况查询（packages/db/src/usage.ts 原文，
 * 仅 answered 的条件有差别）。两种时间形式：`fixed` 用固定 asOf 2026-10-17T04:00Z（性能库的数据截止），
 * `production` 用 statement_timestamp()（接口实际形式）。
 */
const databaseUrl = process.env['PERF_APP_DATABASE_URL'];
assert(databaseUrl, 'PERF_APP_DATABASE_URL is required');
const url = new URL(databaseUrl);
assert.equal(url.pathname, '/fs_billing_perf_pr3_uuid_v4');
assert.equal(url.username, 'fs_billing_app');
assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));

const outDir = resolve(process.argv[2] ?? '.');
mkdirSync(outDir, { recursive: true });

const tenantId = '00000000-0000-4000-8000-000000000001'; // PORTALBIG，300 万条
// PERF_AS_OF 换月份（缺省 10 月，即性能库数据截止的当月；9 月是最重的整月分区）。
const asOf = process.env['PERF_AS_OF'] ?? '2026-10-17T04:00:00Z';
const forms = (process.env['FORMS'] ?? 'fixed,production').split(',') as Form[];
const rounds = Number(process.env['ROUNDS'] ?? 8);

type Form = 'fixed' | 'production';
type Shape = 'answered' | 'overview';
type Variant = 'baseline' | 'bounded';

const instant = (form: Form) =>
  form === 'fixed' ? `'${asOf}'::timestamptz` : 'statement_timestamp()';
const boundsCte = `bounds as (
      select as_of, (as_of at time zone 'Asia/Shanghai')::date as today,
        date_trunc('month', as_of at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai' as month_start,
        (date_trunc('month', as_of at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai' as month_end
      from instant
    )`;
const answeredCte = (variant: Variant) => `answered as (
      select coalesce(sum(c.billed_minutes), 0)::text as minutes, count(*)::int as calls
      from cdrs c cross join bounds b
      where c.tenant_id = '${tenantId}'::uuid
        and c.answered_at >= b.month_start and c.answered_at < b.month_end
        and c.started_at < b.month_end${
          variant === 'bounded'
            ? `
        and c.started_at >= b.month_start - interval '31 days'`
            : ''
        }
    )`;

function statement(shape: Shape, form: Form, variant: Variant) {
  if (shape === 'answered')
    return `with instant as (select ${instant(form)} as as_of),
    ${boundsCte},
    ${answeredCte(variant)}
    select minutes, calls from answered`;
  return `with instant as (select ${instant(form)} as as_of),
    ${boundsCte},
    daily_spend as (
      select (l.occurred_at at time zone 'Asia/Shanghai')::date as day, -sum(l.amount) as spend
      from ledger_entries l
      where l.tenant_id = '${tenantId}'::uuid and l.kind = 'call_charge'
        and l.occurred_at >= (select (today - 29)::timestamp at time zone 'Asia/Shanghai' from bounds)
        and l.occurred_at < (select (today + 1)::timestamp at time zone 'Asia/Shanghai' from bounds)
      group by 1
    ),
    days as (
      select b.today - n as day, coalesce(d.spend, 0) as spend
      from bounds b cross join generate_series(0, 29) n
      left join daily_spend d on d.day = b.today - n
    ),
    ${answeredCte(variant)},
    unanswered as (
      select count(*)::int as calls
      from cdrs c cross join bounds b
      where c.tenant_id = '${tenantId}'::uuid and c.answered_at is null
        and c.started_at >= b.month_start and c.started_at < b.month_end
    )
    select jsonb_build_object(
      'asOf', to_char(b.as_of at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
      'currency', t.currency,
      'monthSpend', coalesce((
    select -sum(l.amount) from ledger_entries l
    where l.tenant_id = t.id and l.kind = 'call_charge'
      and l.occurred_at >= date_trunc('month', b.as_of at time zone 'Asia/Shanghai') at time zone 'Asia/Shanghai'
      and l.occurred_at < (date_trunc('month', b.as_of at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai'
  ), 0)::text,
      'monthCallMinutes', a.minutes,
      'answeredCalls', a.calls,
      'unansweredCalls', u.calls,
      'daily', (select jsonb_agg(jsonb_build_object('date', day, 'spend', spend::text) order by day) from days),
      'dailyTotal', (select sum(spend)::text from days)
    ) as overview
    from tenants t cross join bounds b cross join answered a cross join unanswered u
    where t.id = '${tenantId}'::uuid`;
}

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

async function inTx<T>(run: () => Promise<T>) {
  await client.query('BEGIN READ ONLY');
  try {
    await client.query(
      `select set_config('app.scope', 'tenant', true), set_config('app.tenant_id', $1, true)`,
      [tenantId],
    );
    await client.query('set local jit = off');
    return await run();
  } finally {
    await client.query('ROLLBACK');
  }
}

const number = (text: string, label: string) => {
  const match = new RegExp(`${label}: ([0-9.]+) ms`).exec(text);
  assert(match?.[1], `no ${label} in plan`);
  return Number(match[1]);
};

async function explain(sqlText: string) {
  return inTx(async () => {
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF) ${sqlText}`,
    );
    const text = rows.map((row) => row['QUERY PLAN']).join('\n');
    return {
      text,
      executionMs: number(text, 'Execution Time'),
      planningMs: number(text, 'Planning Time'),
    };
  });
}

async function result(sqlText: string): Promise<unknown> {
  return inTx(async (): Promise<unknown> => {
    const { rows } = await client.query<Record<string, unknown>>(sqlText);
    return rows[0];
  });
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const summary: Record<string, unknown>[] = [];
const runs: Record<string, unknown>[] = [];
for (const shape of ['answered', 'overview'] as const) {
  for (const form of forms) {
    const sql = {
      baseline: statement(shape, form, 'baseline'),
      bounded: statement(shape, form, 'bounded'),
    };
    // 结果必须相同：下界不能改变数字。overview 里的 asOf 字段在 production 形式下每次不同，先去掉。
    const strip = (row: unknown) => {
      const copy = JSON.parse(JSON.stringify(row)) as {
        overview?: { asOf?: string };
      };
      if (copy.overview) delete copy.overview.asOf;
      return copy;
    };
    const same =
      JSON.stringify(strip(await result(sql.baseline))) ===
      JSON.stringify(strip(await result(sql.bounded)));
    assert(same, `${shape}/${form}: results differ`);

    // 第 0 轮是冷/预热轮，单独记录不计入统计。之后每轮交替先后顺序（ABBA）。
    const samples: Record<Variant, number[]> = { baseline: [], bounded: [] };
    const planning: Record<Variant, number[]> = { baseline: [], bounded: [] };
    const lastPlan: Record<Variant, string> = { baseline: '', bounded: '' };
    for (let round = 0; round <= rounds; round += 1) {
      const order: Variant[] =
        round % 2 === 0 ? ['baseline', 'bounded'] : ['bounded', 'baseline'];
      for (const variant of order) {
        const plan = await explain(sql[variant]);
        runs.push({
          shape,
          form,
          variant,
          round,
          warmup: round === 0,
          executionMs: plan.executionMs,
          planningMs: plan.planningMs,
        });
        if (round === 0) continue;
        samples[variant].push(plan.executionMs);
        planning[variant].push(plan.planningMs);
        lastPlan[variant] = plan.text;
      }
    }
    for (const variant of ['baseline', 'bounded'] as const) {
      writeFileSync(
        join(outDir, `plan-${shape}-${form}-${variant}.txt`),
        `${lastPlan[variant]}\n`,
      );
      const values = samples[variant];
      summary.push({
        shape,
        form,
        variant,
        n: values.length,
        executionMs: {
          median: median(values),
          min: Math.min(...values),
          max: Math.max(...values),
        },
        planningMedianMs: median(planning[variant]),
      });
    }
  }
}
await client.end();
writeFileSync(
  join(outDir, 'results.json'),
  `${JSON.stringify({ database: 'fs_billing_perf_pr3_uuid_v4', tenant: 'PORTALBIG', asOf, rounds, summary, runs }, null, 2)}\n`,
);
console.table(
  summary.map((row) => ({
    ...row,
    executionMs: JSON.stringify(row['executionMs']),
  })),
);
