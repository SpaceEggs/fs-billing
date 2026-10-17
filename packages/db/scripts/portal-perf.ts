import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { sql, type SQL } from 'drizzle-orm';
import pg from 'pg';
import { decimal, quoteCsvCell } from '@fs-billing/rating';
import { z } from 'zod';
import { connect, withTenant, type Tx } from '../src/client.js';

const asOf = new Date(
  z.iso
    .datetime({ offset: true })
    .parse(process.env.PERF_AS_OF ?? '2026-10-17T04:00:00Z'),
);
const ownerUrl = z.url().parse(process.env.PERF_DATABASE_URL);
const appUrl = z.url().parse(process.env.PERF_APP_DATABASE_URL);
for (const value of [ownerUrl, appUrl]) {
  const url = new URL(value);
  assert.equal(
    url.pathname,
    '/fs_billing_perf',
    'Use the dedicated fs_billing_perf database',
  );
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname),
    'Use local PostgreSQL',
  );
}
assert.equal(new URL(appUrl).username, 'fs_billing_app');

// PERF_OUT 把结果写到别处（调参对照）；PERF_SETTINGS="random_page_cost=1.1,work_mem=64MB" 在每个事务内 set local；
// PERF_ONLY 是变体名的正则，设置后只测匹配的变体，跳过冷缓存观察、后台现状和导出。
const output = resolve(
  process.env.PERF_OUT ??
    resolve(import.meta.dirname, '../../../docs/perf/portal-cdrs'),
);
const settings = Object.fromEntries(
  (process.env.PERF_SETTINGS ?? '')
    .split(',')
    .filter(Boolean)
    .map((pair) => pair.split('=') as [string, string]),
);
const only = process.env.PERF_ONLY ? new RegExp(process.env.PERF_ONLY) : null;
const fetchSize = z.coerce
  .number()
  .int()
  .positive()
  .parse(process.env.PERF_FETCH ?? 1000);
const DAY_MS = 86_400_000;
const BIG_CDRS = 3_000_000;
const SMALL_CDRS = 30_000;
const CHUNK = 50_000;
// 测量月：最近一个完整的北京自然月；旧月用于余额锚点对照。
const month = {
  from: '2026-09-01T00:00:00+08:00',
  to: '2026-10-01T00:00:00+08:00',
};
const currentMonth = {
  from: '2026-10-01T00:00:00+08:00',
  to: '2026-11-01T00:00:00+08:00',
};
const oldMonth = {
  from: '2025-12-01T00:00:00+08:00',
  to: '2026-01-01T00:00:00+08:00',
};

type Tenant = {
  id: string;
  code: string;
  shape: 'year' | 'export';
  cdrs: number;
};
const tenantId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tenants: Tenant[] = [
  { id: tenantId(1), code: 'PORTALBIG', shape: 'year', cdrs: BIG_CDRS },
  { id: tenantId(2), code: 'PORTALS1', shape: 'year', cdrs: SMALL_CDRS },
  { id: tenantId(3), code: 'PORTALS2', shape: 'year', cdrs: SMALL_CDRS },
  { id: tenantId(4), code: 'PORTALS3', shape: 'year', cdrs: SMALL_CDRS },
  { id: tenantId(5), code: 'EXPORT50K', shape: 'export', cdrs: 50_000 },
  { id: tenantId(6), code: 'EXPORT100K', shape: 'export', cdrs: 100_000 },
  { id: tenantId(7), code: 'EXPORT200K', shape: 'export', cdrs: 200_000 },
];
const big = tenants[0]!;

// 20 个国家/前缀，按 u^2.5 偏斜：中国约 30%，牙买加约 2%。
const COUNTRIES = `(values
  (0, '86', '中国', 0.0500), (1, '1', '美国/加拿大', 0.0100), (2, '44', '英国', 0.0200),
  (3, '81', '日本', 0.0350), (4, '65', '新加坡', 0.0280), (5, '852', '中国香港', 0.0300),
  (6, '63', '菲律宾', 0.1200), (7, '60', '马来西亚', 0.0400), (8, '66', '泰国', 0.0450),
  (9, '84', '越南', 0.0600), (10, '62', '印度尼西亚', 0.0650), (11, '91', '印度', 0.0300),
  (12, '82', '韩国', 0.0400), (13, '49', '德国', 0.0250), (14, '33', '法国', 0.0250),
  (15, '61', '澳大利亚', 0.0300), (16, '971', '阿联酋', 0.1500), (17, '966', '沙特阿拉伯', 0.1200),
  (18, '55', '巴西', 0.0500), (19, '1876', '牙买加', 0.2500)
) as c (idx, prefix, name, rate)`;

/** 第 i 条话单：$1 租户，$2..$3 序号，$4 首条开始时间，$5 时间跨度（秒），$6 条数，$7 接通率阈值。 */
const CDR_INSERT = `
insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
  billing_number, duration_seconds, billed_minutes, matched_prefix, country, rate, charge,
  hangup_cause, unverified)
select $1::uuid, md5($1::text || ':' || i::text)::uuid, t.started,
  case when t.answered then t.started + t.ring end,
  t.started + t.ring + make_interval(secs => case when t.answered then t.dur else 0 end),
  '0755860' || lpad((h.u8 * 100)::int::text, 4, '0'),
  case when h.u9 < 0.3 then '00' when h.u9 < 0.7 then '+' else '' end || c.prefix || t.national,
  c.prefix || t.national,
  case when t.answered then t.dur else 0 end,
  case when t.answered then ceil(t.dur / 60.0) else 0 end,
  case when t.answered then c.prefix end,
  case when t.answered then c.name end,
  case when t.answered then c.rate end,
  case when t.answered then ceil(t.dur / 60.0) * c.rate else 0 end,
  case when t.answered then 'NORMAL_CLEARING' when h.u5 < 0.03 then 'USER_BUSY' else 'NO_ANSWER' end,
  h.u6 < 0.01
from generate_series($2::int, $3::int) i
cross join lateral (select
  (hashint8extended(i, 1) & 2147483647)::float8 / 2147483648 as u1,
  (hashint8extended(i, 2) & 2147483647)::float8 / 2147483648 as u2,
  (hashint8extended(i, 3) & 2147483647)::float8 / 2147483648 as u3,
  (hashint8extended(i, 4) & 2147483647)::float8 / 2147483648 as u4,
  (hashint8extended(i, 5) & 2147483647)::float8 / 2147483648 as u5,
  (hashint8extended(i, 6) & 2147483647)::float8 / 2147483648 as u6,
  (hashint8extended(i, 8) & 2147483647)::float8 / 2147483648 as u8,
  (hashint8extended(i, 9) & 2147483647)::float8 / 2147483648 as u9,
  hashint8extended(i, 7) & 2147483647 as n7) h
join ${COUNTRIES} on c.idx = least(19, floor(20 * power(h.u1, 2.5))::int)
cross join lateral (select
  $4::timestamptz + make_interval(secs => $5::float8 * (i - 1) / $6::int) as started,
  h.u5 >= $7::float8 as answered,
  make_interval(secs => case when h.u5 >= $7::float8 then 3 + floor(h.u4 * 25) else 5 + floor(h.u4 * 55) end) as ring,
  least(3600, 1 + floor(-ln(1 - h.u3) * 90))::int as dur,
  -- 10% 打给 2000 个常用号码，其余随机。
  case when h.u2 < 0.1 then (100000000 + h.n7 % 2000)::text
    else (100000000 + h.n7 % 900000000)::text end as national) t
`;

async function seed() {
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await owner.query("select set_config('app.scope', 'admin', false)");
    const yearStart = new Date(asOf.getTime() - 365 * DAY_MS);
    await owner.query('select cdr_ensure_partitions($1::timestamptz, 13)', [
      yearStart,
    ]);
    const admin = await owner.query<{ id: string }>(
      'select id from admins order by id limit 1',
    );
    const adminId = admin.rows[0]?.id;
    assert(adminId, 'Run pnpm db:seed first: the fixture needs an admin');
    for (const tenant of tenants) {
      const existing = await owner.query<{ count: string }>(
        'select count(*) from cdrs where tenant_id = $1',
        [tenant.id],
      );
      if (existing.rows[0]?.count === String(tenant.cdrs)) {
        process.stderr.write(`skip ${tenant.code}: already seeded\n`);
        continue;
      }
      assert.equal(
        existing.rows[0]?.count,
        '0',
        `${tenant.code} is partially seeded; drop and recreate fs_billing_perf`,
      );
      await owner.query(
        `insert into tenants (id, code, name, currency, overdraft_limit)
         values ($1, $2, $3, 'CNY', 1000) on conflict (id) do nothing`,
        [tenant.id, tenant.code, `门户性能 ${tenant.code}`],
      );
      // year：最近 365 天均匀分布，95% 接通；export：2026-09 北京月内全部接通。
      const [start, spanSeconds, answeredBelow] =
        tenant.shape === 'year'
          ? [yearStart, 365 * 86_400, 0.05]
          : [new Date(month.from), 30 * 86_400 - 3_600, 0];
      for (let first = 1; first <= tenant.cdrs; first += CHUNK) {
        const last = Math.min(first + CHUNK - 1, tenant.cdrs);
        const chunkFrom = new Date(
          start.getTime() + (spanSeconds * 1000 * (first - 1)) / tenant.cdrs,
        );
        const chunkTo = new Date(
          start.getTime() + (spanSeconds * 1000 * last) / tenant.cdrs,
        );
        await owner.query('begin');
        try {
          await owner.query('select lock_tenants(array[$1::uuid])', [
            tenant.id,
          ]);
          await owner.query(CDR_INSERT, [
            tenant.id,
            first,
            last,
            start,
            spanSeconds,
            tenant.cdrs,
            answeredBelow,
          ]);
          if (tenant.shape === 'year')
            await owner.query(
              `insert into ledger_entries (tenant_id, kind, amount, idempotency_key, occurred_at)
               select tenant_id, 'call_charge', -charge, 'call:' || call_uuid, answered_at
               from cdrs where tenant_id = $1 and started_at >= $2 and started_at < $3
                 and answered_at is not null`,
              [tenant.id, chunkFrom, chunkTo],
            );
          await owner.query('commit');
        } catch (error) {
          await owner.query('rollback');
          throw error;
        }
        process.stderr.write(
          `${JSON.stringify({ event: 'seed.progress', tenant: tenant.code, cdrs: last })}\n`,
        );
      }
      if (tenant.shape === 'year') {
        const charges = await owner.query<{ cdrs: string; ledger: string }>(
          `select (select count(*) from cdrs where tenant_id = $1 and answered_at is not null) as cdrs,
            (select count(*) from ledger_entries where tenant_id = $1 and kind = 'call_charge') as ledger`,
          [tenant.id],
        );
        assert.equal(charges.rows[0]?.ledger, charges.rows[0]?.cdrs);
        await owner.query('begin');
        try {
          await owner.query('select lock_tenants(array[$1::uuid])', [
            tenant.id,
          ]);
          // 每月 1 日充值、15 日赠送、20 日调账；人工流水 occurred_at = created_at。
          await owner.query(
            `insert into ledger_entries (tenant_id, kind, amount, note, created_by,
               idempotency_key, occurred_at, created_at)
             select $1::uuid, e.kind, e.amount * $3::numeric, e.note, $2::uuid,
               'perf:' || e.kind || ':' || m::date, at, at
             from generate_series(date_trunc('month', $4::timestamptz at time zone 'Asia/Shanghai'),
               date_trunc('month', $5::timestamptz at time zone 'Asia/Shanghai'), interval '1 month') m
             cross join (values ('recharge', 30000, '', 0), ('gift', 500, '', 14),
               ('adjustment', -12.34, '线路故障补差', 19)) e (kind, amount, note, day)
             cross join lateral (select (m + make_interval(days => e.day, hours => 10)) at time zone 'Asia/Shanghai' as at) a
             where at < $5::timestamptz`,
            [tenant.id, adminId, tenant.cdrs / BIG_CDRS, yearStart, asOf],
          );
          await owner.query('commit');
        } catch (error) {
          await owner.query('rollback');
          throw error;
        }
      }
    }
    // 阶段 7 的月账单：每个完整北京月一行，期初 = 月初前流水合计。门户余额锚点可直接读期初。
    await owner.query(
      `insert into monthly_statements (tenant_id, month, opening_balance, recharge, gift,
         adjustment, call_charges, closing_balance, call_minutes)
       select t.id, m.month,
         coalesce((select sum(amount) from ledger_entries p where p.tenant_id = t.id
           and p.occurred_at < m.month at time zone 'Asia/Shanghai'), 0) as opening,
         s.recharge, s.gift, s.adjustment, s.call_charges,
         coalesce((select sum(amount) from ledger_entries p where p.tenant_id = t.id
           and p.occurred_at < (m.month + interval '1 month') at time zone 'Asia/Shanghai'), 0),
         (select coalesce(sum(billed_minutes), 0) from cdrs c where c.tenant_id = t.id
           and c.answered_at >= m.month at time zone 'Asia/Shanghai'
           and c.answered_at < (m.month + interval '1 month') at time zone 'Asia/Shanghai')
       from tenants t cross join generate_series(
           date_trunc('month', ($1::timestamptz - interval '365 days') at time zone 'Asia/Shanghai'),
           date_trunc('month', $1::timestamptz at time zone 'Asia/Shanghai') - interval '1 month',
           interval '1 month') m (month)
       cross join lateral (select
           coalesce(sum(amount) filter (where kind in ('recharge', 'credit_recharge')), 0) as recharge,
           coalesce(sum(amount) filter (where kind = 'gift'), 0) as gift,
           coalesce(sum(amount) filter (where kind = 'adjustment'), 0) as adjustment,
           coalesce(-sum(amount) filter (where kind = 'call_charge'), 0) as call_charges
         from ledger_entries l where l.tenant_id = t.id
           and l.occurred_at >= m.month at time zone 'Asia/Shanghai'
           and l.occurred_at < (m.month + interval '1 month') at time zone 'Asia/Shanghai') s
       where t.code = any($2::text[])
       on conflict (tenant_id, month) do nothing`,
      [asOf, tenants.filter((t) => t.shape === 'year').map((t) => t.code)],
    );
    await owner.query('vacuum (analyze)');
  } finally {
    await owner.end();
  }
}

// ---------------------------------------------------------------- measure

type Range = { from: string; to: string };
const COLUMN_NAMES = [
  'call_uuid',
  'started_at',
  'answered_at',
  'ended_at',
  'caller',
  'callee',
  'country',
  'duration_seconds',
  'billed_minutes',
  'rate',
  'charge',
  'hangup_cause',
];
const COLUMNS = sql.raw(COLUMN_NAMES.join(', '));
const JOINED_COLUMNS = sql.raw(COLUMN_NAMES.map((c) => `c.${c}`).join(', '));
const ANSWERED_DESC = sql.raw('answered_at desc, call_uuid desc');
const ALL_AT = sql.raw('coalesce(answered_at, started_at)');

/**
 * started_at 下界 = 月初 - 1 天：answered_at >= started_at，而振铃不会超过 1 天，所以不漏行。
 * 在应用层算好再传参，规划期就能裁剪分区（`$1 - interval` 是 STABLE，只能执行期裁剪）。
 */
const startedFloor = (range: Range) =>
  new Date(Date.parse(range.from) - DAY_MS).toISOString();
const and = (extra?: SQL) => (extra ? sql`and ${extra}` : sql``);

/** 已接通视图：按 answered_at 归属。 */
function answeredWhere(t: string, extra?: SQL, range = month) {
  return sql`tenant_id = ${t} and answered_at >= ${range.from}::timestamptz
    and answered_at < ${range.to}::timestamptz
    and started_at >= ${startedFloor(range)}::timestamptz
    and started_at < ${range.to}::timestamptz ${and(extra)}`;
}
/** 全部视图：接通的按 answered_at、未接通的按 started_at 归属。 */
function allWhere(t: string, extra?: SQL) {
  return sql`tenant_id = ${t} and ${ALL_AT} >= ${month.from}::timestamptz
    and ${ALL_AT} < ${month.to}::timestamptz
    and started_at >= ${startedFloor(month)}::timestamptz
    and started_at < ${month.to}::timestamptz ${and(extra)}`;
}
const page = (offset: number) => sql`limit 50 offset ${offset}`;

function answeredPage(t: string, offset: number, extra?: SQL) {
  return sql`select ${COLUMNS} from cdrs where ${answeredWhere(t, extra)}
    order by ${ANSWERED_DESC} ${page(offset)}`;
}
/** 后半段页反向取：升序跳过 total - offset - 50 条，应用层再倒序。 */
function answeredPageReverse(t: string, reverseOffset: number) {
  return sql`select ${COLUMNS} from cdrs where ${answeredWhere(t)}
    order by answered_at asc, call_uuid asc ${page(reverseOffset)}`;
}
/** 延迟回表：先在覆盖索引上 index-only 跳过 offset 行取 50 个主键，再回表取整行。 */
function answeredPageDeferred(t: string, offset: number) {
  return sql`with k as (select call_uuid, started_at, answered_at from cdrs
      where ${answeredWhere(t)} order by ${ANSWERED_DESC} ${page(offset)})
    select ${JOINED_COLUMNS}
    from k join cdrs c on c.tenant_id = ${t} and c.call_uuid = k.call_uuid and c.started_at = k.started_at
    order by k.answered_at desc, k.call_uuid desc`;
}
function answeredKeyset(t: string, cursor: { at: string; uuid: string }) {
  return sql`select ${COLUMNS} from cdrs where ${answeredWhere(t)}
    and (answered_at, call_uuid) < (${cursor.at}::timestamptz, ${cursor.uuid}::uuid)
    order by ${ANSWERED_DESC} limit 50`;
}
function answeredSummary(t: string, extra?: SQL) {
  return sql`select count(*)::int as calls, sum(billed_minutes)::text as minutes,
    sum(charge)::text as charge from cdrs where ${answeredWhere(t, extra)}`;
}
/** 已接通视图的"含未接通 N"：未接通按 started_at 归属。 */
function unansweredCount(t: string, extra?: SQL) {
  return sql`select count(*)::int as unanswered from cdrs where tenant_id = ${t}
    and answered_at is null and started_at >= ${month.from}::timestamptz
    and started_at < ${month.to}::timestamptz ${and(extra)}`;
}
function allPage(t: string, offset: number) {
  return sql`select ${COLUMNS} from cdrs where ${allWhere(t)}
    order by ${ALL_AT} desc, call_uuid desc ${page(offset)}`;
}
function allPageDeferred(t: string, offset: number) {
  return sql`with k as (select call_uuid, started_at, ${ALL_AT} as at from cdrs
      where ${allWhere(t)} order by ${ALL_AT} desc, call_uuid desc ${page(offset)})
    select ${JOINED_COLUMNS} from k join cdrs c on c.tenant_id = ${t} and c.call_uuid = k.call_uuid
      and c.started_at = k.started_at
    order by k.at desc, k.call_uuid desc`;
}
function allSummary(t: string) {
  return sql`select count(*)::int as calls,
    count(*) filter (where answered_at is null)::int as unanswered,
    sum(billed_minutes)::text as minutes, sum(charge)::text as charge
    from cdrs where ${allWhere(t)}`;
}
/** 全部视图改按 started_at 排序与归属，用现有 0010 索引。 */
function startedPage(t: string, offset: number) {
  return sql`select ${COLUMNS} from cdrs where tenant_id = ${t}
    and started_at >= ${month.from}::timestamptz and started_at < ${month.to}::timestamptz
    order by started_at desc, call_uuid desc ${page(offset)}`;
}
/** 全部视图不加新索引：接通分支走 answered_at 索引，未接通分支走 started_at 索引。 */
function unionPage(t: string, offset: number) {
  return sql`select * from (
      select ${COLUMNS}, answered_at as at from cdrs where ${answeredWhere(t)}
      union all
      select ${COLUMNS}, started_at as at from cdrs where tenant_id = ${t}
        and answered_at is null and started_at >= ${month.from}::timestamptz
        and started_at < ${month.to}::timestamptz
    ) u order by at desc, call_uuid desc ${page(offset)}`;
}

type Anchor = 'prior' | 'balance' | 'statement';
/**
 * 查询月月初的余额。prior：月初前全部流水之和。balance：tenant_balances 减去月初及之后的流水
 * （同一快照内余额行与流水由触发器同事务维护）。statement：最近一张月账单的期末，加上它之后到月初的流水。
 */
function anchorSql(t: string, range: Range, anchor: Anchor) {
  if (anchor === 'prior')
    return sql`select coalesce(sum(amount), 0) as a from ledger_entries
      where tenant_id = ${t} and occurred_at < ${range.from}::timestamptz`;
  if (anchor === 'balance')
    return sql`select b.balance - coalesce((select sum(amount) from ledger_entries
      where tenant_id = ${t} and occurred_at >= ${range.from}::timestamptz), 0) as a
      from tenant_balances b where b.tenant_id = ${t}`;
  return sql`select s.closing_balance + coalesce((select sum(amount) from ledger_entries
      where tenant_id = ${t}
        and occurred_at >= (s.month + interval '1 month') at time zone 'Asia/Shanghai'
        and occurred_at < ${range.from}::timestamptz), 0) as a
    from monthly_statements s where s.tenant_id = ${t}
      and s.month < (${range.from}::timestamptz at time zone 'Asia/Shanghai')::date
    order by s.month desc limit 1`;
}

/**
 * 门户余额流水，逐条窗口：先对月内每条流水算真实的变动后余额，再把通话扣费按北京日合并，
 * 合并行取当天最后一笔扣费后的余额。
 */
function ledgerRowWindow(t: string, range: Range, anchor: Anchor) {
  return sql`with anchor as (${anchorSql(t, range, anchor)}),
    running as (
      select l.id, l.kind, l.amount, l.note, l.occurred_at,
        anchor.a + sum(l.amount) over (order by l.occurred_at, l.id) as balance_after
      from ledger_entries l, anchor
      where l.tenant_id = ${t} and l.occurred_at >= ${range.from}::timestamptz
        and l.occurred_at < ${range.to}::timestamptz
    ),
    merged as (
      select null::uuid as id, 'call_charge' as kind,
        (occurred_at at time zone 'Asia/Shanghai')::date as day,
        max(occurred_at) as at, count(*)::int as calls, sum(amount) as amount,
        (array_agg(balance_after order by occurred_at desc, id desc))[1] as balance_after
      from running where kind = 'call_charge' group by 3
      union all
      select id, kind, (occurred_at at time zone 'Asia/Shanghai')::date, occurred_at, null,
        amount, balance_after from running where kind <> 'call_charge'
    )
    select id, kind, day, at, calls, amount::text, balance_after::text from merged
    order by at desc, id desc nulls last limit 50`;
}
/**
 * 门户余额流水，先合并后窗口：一次扫描把扣费按北京日分组、其他流水各成一组，
 * 再对约 33 行算累计余额。合并行位于当天最后一笔扣费的时间，相邻行余额逐行可对上。
 */
function ledgerDayWindow(t: string, range: Range, anchor: Anchor) {
  return sql`with anchor as (${anchorSql(t, range, anchor)}),
    merged as (
      select case when kind = 'call_charge' then null else id end as id, kind,
        (occurred_at at time zone 'Asia/Shanghai')::date as day,
        max(occurred_at) as at, count(*)::int as calls, sum(amount) as amount, max(note) as note
      from ledger_entries
      where tenant_id = ${t} and occurred_at >= ${range.from}::timestamptz
        and occurred_at < ${range.to}::timestamptz
      group by 1, 2, 3
    )
    select id, kind, day, at, calls, amount::text,
      (anchor.a + sum(amount) over (order by at, id nulls first))::text as balance_after
    from merged, anchor
    order by at desc, id desc nulls last limit 50`;
}
/** 后台现状（admin/balance.ts）：每行一个相关子查询求和全部更早流水。 */
function adminLedger(t: string) {
  return sql`select l.id, l.kind, l.amount::text, l.occurred_at,
    (select sum(prior.amount)::text from ledger_entries prior where prior.tenant_id = l.tenant_id
      and (prior.occurred_at, prior.id) <= (l.occurred_at, l.id)) as balance_after
    from ledger_entries l where l.tenant_id = ${t}
      and l.occurred_at >= ${month.from}::timestamptz and l.occurred_at < ${month.to}::timestamptz
    order by l.occurred_at desc, l.id desc limit 50`;
}

/** 候选索引（不进 main 的 migration；本库测完保留到 drop 数据库）。父表建索引会建到每个分区。 */
const CANDIDATE_INDEXES = {
  cdrs_tenant_answered_keys:
    'on cdrs (tenant_id, answered_at, call_uuid) include (started_at)',
  cdrs_tenant_all_keys:
    'on cdrs (tenant_id, (coalesce(answered_at, started_at)), call_uuid) include (started_at, answered_at)',
};

type Variant = { name: string; query: SQL };
type Db = Parameters<typeof withTenant>[0];
async function applySettings(tx: Tx) {
  for (const [name, value] of Object.entries(settings))
    await tx.execute(sql`select set_config(${name}, ${value}, true)`);
}
const inTenant = <T>(db: Db, fn: (tx: Tx) => Promise<T>) =>
  withTenant(db, big.id, async (tx) => {
    await applySettings(tx);
    return fn(tx);
  });
const rowsOf = async (tx: Tx, query: SQL) => (await tx.execute(query)).rows;

async function measure() {
  await mkdir(resolve(output, 'plans'), { recursive: true });
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const { db, pool } = connect(appUrl, { max: 1 });
  try {
    await owner.query('create extension if not exists pg_buffercache');
    for (const name of Object.keys(CANDIDATE_INDEXES))
      await owner.query(`drop index if exists ${name}`);
    await owner.query('vacuum (analyze) cdrs');
    const facts = await fixture(owner);
    const answered = facts.answered;
    const all = answered + facts.unanswered;
    const mid = (n: number) => Math.floor(n / 2 / 50) * 50;
    const last = (n: number) => Math.floor((n - 1) / 50) * 50;
    const cursor = await inTenant(db, async (tx) => {
      const rows = await rowsOf(tx, answeredPage(big.id, mid(answered) - 50));
      // drizzle 的 execute 把 timestamptz 原样返回为文本。
      return {
        at: String(rows.at(-1)!.answered_at),
        uuid: String(rows.at(-1)!.call_uuid),
      };
    });
    const like = (q: string) => sql`billing_number like ${'%' + q + '%'}`;
    // 常用子串命中约 5%（常用号码），罕见子串一个月只命中 1 条，见 fixture.json。
    const substrings = { common: '100000', rare: '424242' };
    const countries = { common: '中国', rare: '牙买加' };
    const base: Variant[] = [
      { name: 'Q1 answered p1', query: answeredPage(big.id, 0) },
      { name: 'Q1 answered mid', query: answeredPage(big.id, mid(answered)) },
      { name: 'Q1 answered last', query: answeredPage(big.id, last(answered)) },
      {
        name: 'Q1 answered last (reverse)',
        query: answeredPageReverse(big.id, 0),
      },
      { name: 'Q2 all p1', query: allPage(big.id, 0) },
      { name: 'Q2 all mid', query: allPage(big.id, mid(all)) },
      { name: 'Q2 all p1 (union)', query: unionPage(big.id, 0) },
      { name: 'Q2 all p1 (started_at)', query: startedPage(big.id, 0) },
      { name: 'Q2 all mid (started_at)', query: startedPage(big.id, mid(all)) },
      { name: 'Q3 answered summary', query: answeredSummary(big.id) },
      { name: 'Q3 unanswered count', query: unansweredCount(big.id) },
      { name: 'Q3 all summary', query: allSummary(big.id) },
      ...(['common', 'rare'] as const).flatMap((kind) => [
        {
          name: `Q4 ${kind} p1`,
          query: answeredPage(big.id, 0, like(substrings[kind])),
        },
        {
          name: `Q4 ${kind} summary`,
          query: answeredSummary(big.id, like(substrings[kind])),
        },
      ]),
      { name: 'Q5 keyset mid', query: answeredKeyset(big.id, cursor) },
      ...(['common', 'rare'] as const).flatMap((kind) => {
        const filter = sql`country = ${countries[kind]}`;
        return [
          { name: `Q6 ${kind} p1`, query: answeredPage(big.id, 0, filter) },
          {
            name: `Q6 ${kind} summary`,
            query: answeredSummary(big.id, filter),
          },
        ];
      }),
      {
        name: 'Q7 Sep row-window prior',
        query: ledgerRowWindow(big.id, month, 'prior'),
      },
      {
        name: 'Q7 Sep row-window balance',
        query: ledgerRowWindow(big.id, month, 'balance'),
      },
      {
        name: 'Q7 Sep day-window prior',
        query: ledgerDayWindow(big.id, month, 'prior'),
      },
      {
        name: 'Q7 Sep day-window balance',
        query: ledgerDayWindow(big.id, month, 'balance'),
      },
      {
        name: 'Q7 Sep day-window statement',
        query: ledgerDayWindow(big.id, month, 'statement'),
      },
      {
        name: 'Q7 Oct day-window balance',
        query: ledgerDayWindow(big.id, currentMonth, 'balance'),
      },
      {
        name: 'Q7 Oct day-window statement',
        query: ledgerDayWindow(big.id, currentMonth, 'statement'),
      },
      {
        name: 'Q7 Dec day-window prior',
        query: ledgerDayWindow(big.id, oldMonth, 'prior'),
      },
      {
        name: 'Q7 Dec day-window balance',
        query: ledgerDayWindow(big.id, oldMonth, 'balance'),
      },
      {
        name: 'Q7 Dec day-window statement',
        query: ledgerDayWindow(big.id, oldMonth, 'statement'),
      },
    ];
    const withCandidates: Variant[] = [
      {
        name: 'Q1 answered mid (deferred)',
        query: answeredPageDeferred(big.id, mid(answered)),
      },
      {
        name: 'Q2 all mid (deferred)',
        query: allPageDeferred(big.id, mid(all)),
      },
    ];

    await verify(db, { answered, all, cursor, facts, mid, last });
    const picked = (variants: Variant[]) =>
      variants.filter((v) => !only || only.test(v.name));
    const cold = only
      ? []
      : await coldObservation(
          owner,
          base.filter((v) =>
            [
              'Q1 answered p1',
              'Q1 answered mid',
              'Q3 answered summary',
            ].includes(v.name),
          ),
        );
    const rounds = Number(process.env.PERF_ROUNDS ?? 20);
    const baseline = await timeVariants(db, 'baseline', picked(base), rounds);
    await planVariants(db, 'baseline', picked(base));

    for (const [name, definition] of Object.entries(CANDIDATE_INDEXES))
      await owner.query(`create index ${name} ${definition}`);
    await owner.query('vacuum (analyze) cdrs');
    const indexSizes =
      await owner.query(`select p.relname as index, pg_size_pretty(sum(pg_relation_size(c.oid))) as size
      from pg_inherits i join pg_class c on c.oid = i.inhrelid join pg_class p on p.oid = i.inhparent
      where p.relname in ('cdrs_tenant_answered_at', 'cdrs_tenant_started_at', ${Object.keys(
        CANDIDATE_INDEXES,
      )
        .map((n) => `'${n}'`)
        .join(', ')})
      group by p.relname order by 1`);
    await verifyCandidates(db, answered, all, mid);
    const candidateVariants = picked([...base, ...withCandidates]);
    const candidates = await timeVariants(
      db,
      'candidates',
      candidateVariants,
      rounds,
    );
    await planVariants(db, 'candidates', candidateVariants);

    // 后台现状每次约一分钟，只跑 3 次并单独标注。
    const admin = { name: 'Q7 admin correlated sum', ms: [] as number[] };
    if (!only) {
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        await inTenant(db, (tx) => tx.execute(adminLedger(big.id)));
        admin.ms.push(+(performance.now() - started).toFixed(1));
      }
      await planVariants(db, 'candidates', [
        { name: admin.name, query: adminLedger(big.id) },
      ]);
    }

    await writeFile(
      resolve(output, 'timings.json'),
      JSON.stringify(
        {
          rounds,
          settings,
          baseline,
          candidates,
          admin,
          cold,
          indexSizes: indexSizes.rows,
        },
        null,
        2,
      ),
    );
    console.table(
      candidateVariants.map((v) => {
        const b = baseline.find((r) => r.name === v.name);
        const c = candidates.find((r) => r.name === v.name)!;
        return {
          name: v.name,
          baseP50: b?.p50,
          baseP95: b?.p95,
          candP50: c.p50,
          candP95: c.p95,
        };
      }),
    );
    console.table([admin]);
    console.table(cold);
  } finally {
    await pool.end();
    await owner.end();
  }
  if (!only) await measureExport();
}

async function fixture(owner: pg.Client) {
  const metadata = await owner.query<{ version: string }>(`select version(),
    current_setting('shared_buffers') as shared_buffers, current_setting('work_mem') as work_mem,
    current_setting('random_page_cost') as random_page_cost, current_setting('jit') as jit,
    current_setting('max_parallel_workers_per_gather') as max_parallel_workers_per_gather,
    current_setting('effective_cache_size') as effective_cache_size,
    pg_size_pretty(pg_database_size(current_database())) as database_size`);
  assert.match(String(metadata.rows[0]?.version), /^PostgreSQL 17\./);
  const shape = await owner.query(`select t.code, count(*)::int as cdrs,
    count(*) filter (where answered_at is null)::int as unanswered,
    count(*) filter (where unverified)::int as unverified,
    count(distinct country)::int as countries, min(started_at) as first_started,
    max(started_at) as last_started from cdrs join tenants t on t.id = tenant_id
    group by t.code order by cdrs desc`);
  const partitions =
    await owner.query(`select c.relname, c.reltuples::bigint as rows,
    pg_size_pretty(pg_relation_size(c.oid)) as heap
    from pg_inherits i join pg_class c on c.oid = i.inhrelid
    where i.inhparent = 'cdrs'::regclass order by 1`);
  const ledger = await owner.query(
    `select kind, count(*)::int from ledger_entries
    where tenant_id = $1 group by kind order by kind`,
    [big.id],
  );
  const truth = await owner.query<{
    answered: number;
    unanswered: number;
    answered_crossing: number;
    max_ring: string;
    common_hits: number;
    rare_hits: number;
    china: number;
    jamaica: number;
  }>(
    `select
      count(*) filter (where answered_at >= $2 and answered_at < $3)::int as answered,
      count(*) filter (where answered_at is null and started_at >= $2 and started_at < $3)::int as unanswered,
      count(*) filter (where answered_at >= $2 and answered_at < $3 and started_at < $2)::int as answered_crossing,
      max(answered_at - started_at)::text as max_ring,
      count(*) filter (where answered_at >= $2 and answered_at < $3 and billing_number like '%100000%')::int as common_hits,
      count(*) filter (where answered_at >= $2 and answered_at < $3 and billing_number like '%424242%')::int as rare_hits,
      count(*) filter (where answered_at >= $2 and answered_at < $3 and country = '中国')::int as china,
      count(*) filter (where answered_at >= $2 and answered_at < $3 and country = '牙买加')::int as jamaica
     from cdrs where tenant_id = $1`,
    [big.id, month.from, month.to],
  );
  const facts = truth.rows[0]!;
  await writeFile(
    resolve(output, 'fixture.json'),
    JSON.stringify(
      {
        asOf,
        month,
        metadata: metadata.rows,
        shape: shape.rows,
        partitions: partitions.rows,
        ledger: ledger.rows,
        facts,
      },
      null,
      2,
    ),
  );
  return facts;
}

/** 每轮按轮换起点跑一遍全部变体，前两轮预热不计；计时包含 withTenant 的 begin/set_config/commit。 */
async function timeVariants(
  db: Db,
  phase: string,
  variants: Variant[],
  rounds: number,
) {
  const samples = new Map<string, number[]>(variants.map((v) => [v.name, []]));
  for (let round = -2; round < rounds; round++) {
    const shift = (round + 2) % variants.length;
    for (const v of [...variants.slice(shift), ...variants.slice(0, shift)]) {
      const started = performance.now();
      const result = await inTenant(db, (tx) => tx.execute(v.query));
      const ms = performance.now() - started;
      assert(result.rows.length > 0, `${v.name} returned no rows`);
      if (round >= 0) samples.get(v.name)!.push(ms);
    }
    process.stderr.write(`${phase} round ${round}\n`);
  }
  return variants.map((v) => {
    const sorted = [...samples.get(v.name)!].sort((a, b) => a - b);
    const pct = (p: number) =>
      sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
    return {
      name: v.name,
      n: sorted.length,
      min: round(sorted[0]!),
      p50: round(pct(0.5)),
      p95: round(pct(0.95)),
      max: round(sorted.at(-1)!),
    };
  });
}

async function planVariants(db: Db, phase: string, variants: Variant[]) {
  await mkdir(resolve(output, 'plans', phase), { recursive: true });
  for (const v of variants) {
    const plan = await inTenant(db, (tx) =>
      rowsOf(tx, sql`explain (analyze, buffers) ${v.query}`),
    );
    await writeFile(
      resolve(output, 'plans', phase, `${slug(v.name)}.txt`),
      `${plan.map((r) => r['QUERY PLAN']).join('\n')}\n`,
    );
  }
}

const round = (ms: number) => Number(ms.toFixed(1));
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const ids = (rows: Record<string, unknown>[]) =>
  rows.map((r) => String(r.call_uuid));

/** 断言各变体返回同样的行，计数与 owner 直查一致：测的是正确的工作。 */
async function verify(
  db: Db,
  ctx: {
    answered: number;
    all: number;
    cursor: { at: string; uuid: string };
    facts: {
      unanswered: number;
      answered_crossing: number;
      common_hits: number;
      rare_hits: number;
    };
    mid: (n: number) => number;
    last: (n: number) => number;
  },
) {
  assert(
    ctx.facts.answered_crossing > 0,
    'fixture has calls answered after the month started in the previous day',
  );
  await inTenant(db, async (tx) => {
    assert.equal((await rowsOf(tx, answeredPage(big.id, 0))).length, 50);
    const mid = await rowsOf(tx, answeredPage(big.id, ctx.mid(ctx.answered)));
    const keyset = await rowsOf(tx, answeredKeyset(big.id, ctx.cursor));
    assert.deepEqual(ids(keyset), ids(mid), 'keyset page equals offset page');
    const last = await rowsOf(tx, answeredPage(big.id, ctx.last(ctx.answered)));
    const reverse = await rowsOf(tx, answeredPageReverse(big.id, 0));
    assert.deepEqual(
      ids(reverse).slice(0, last.length).reverse(),
      ids(last),
      'reverse last page equals offset last page',
    );
    const [summary] = await rowsOf(tx, answeredSummary(big.id));
    assert.equal(summary?.calls, ctx.answered);
    const [unanswered] = await rowsOf(tx, unansweredCount(big.id));
    assert.equal(unanswered?.unanswered, ctx.facts.unanswered);
    const [allSummaryRow] = await rowsOf(tx, allSummary(big.id));
    assert.equal(allSummaryRow?.calls, ctx.all);
    assert.equal(allSummaryRow?.unanswered, ctx.facts.unanswered);
    const union = await rowsOf(tx, unionPage(big.id, 0));
    assert.deepEqual(
      ids(union),
      ids(await rowsOf(tx, allPage(big.id, 0))),
      'union 全部 page agrees',
    );
    const [common] = await rowsOf(
      tx,
      answeredSummary(big.id, sql`billing_number like '%100000%'`),
    );
    assert.equal(common?.calls, ctx.facts.common_hits);
    const [rare] = await rowsOf(
      tx,
      answeredSummary(big.id, sql`billing_number like '%424242%'`),
    );
    assert.equal(rare?.calls, ctx.facts.rare_hits);

    for (const range of [month, oldMonth, currentMonth]) {
      const day = [];
      for (const anchor of ['prior', 'balance', 'statement'] as const)
        day.push(await rowsOf(tx, ledgerDayWindow(big.id, range, anchor)));
      assert(day[0]!.length > 15, 'a month has one merged row per day');
      assert.deepEqual(
        day[1],
        day[0],
        'balance anchor equals prior-sum anchor',
      );
      assert.deepEqual(
        day[2],
        day[0],
        'statement anchor equals prior-sum anchor',
      );
      // 先合并后窗口：相邻行逐行可对上。
      const rows = day[0]!;
      for (let i = 0; i + 1 < rows.length; i++)
        assert.equal(
          decimal(String(rows[i + 1]!.balance_after))
            .plus(String(rows[i]!.amount))
            .toFixed(),
          decimal(String(rows[i]!.balance_after)).toFixed(),
        );
      // 合并行余额 = 当天最后一笔扣费后的真实余额，与逐条窗口一致。
      const row = await rowsOf(tx, ledgerRowWindow(big.id, range, 'prior'));
      const callBalances = (rs: Record<string, unknown>[]) =>
        rs
          .filter((r) => r.kind === 'call_charge')
          .map((r) => [r.day, r.balance_after]);
      assert.deepEqual(callBalances(rows), callBalances(row));
    }
    const [current] = await rowsOf(
      tx,
      ledgerDayWindow(big.id, currentMonth, 'prior'),
    );
    const [balance] = await rowsOf(
      tx,
      sql`select balance::text from tenant_balances where tenant_id = ${big.id}`,
    );
    assert.equal(
      decimal(String(current?.balance_after)).toFixed(),
      decimal(String(balance?.balance)).toFixed(),
      'newest row ends at the cached balance',
    );
  });
  const leaked = await withTenant(db, tenants[1]!.id, (tx) =>
    rowsOf(
      tx,
      sql`select count(*)::int as n from cdrs where tenant_id = ${big.id}`,
    ),
  );
  assert.equal(leaked[0]?.n, 0, 'RLS hides other tenants');
}

async function verifyCandidates(
  db: Db,
  answered: number,
  all: number,
  mid: (n: number) => number,
) {
  await inTenant(db, async (tx) => {
    const plain = await rowsOf(tx, answeredPage(big.id, mid(answered)));
    const deferred = await rowsOf(
      tx,
      answeredPageDeferred(big.id, mid(answered)),
    );
    assert.deepEqual(
      ids(deferred),
      ids(plain),
      'deferred join equals plain page',
    );
    assert.deepEqual(
      ids(await rowsOf(tx, allPageDeferred(big.id, mid(all)))),
      ids(await rowsOf(tx, allPage(big.id, mid(all)))),
      'deferred 全部 page equals plain page',
    );
  });
}

/**
 * 冷一点的观察：清掉本库在 shared_buffers 里的页（容器的 OS 页缓存仍是热的），
 * 新连接、DISCARD ALL 后连跑 3 次。
 */
async function coldObservation(owner: pg.Client, variants: Variant[]) {
  const results = [];
  for (const variant of variants) {
    const evicted = await owner.query<{ n: number }>(
      `select count(*) filter (where pg_buffercache_evict(bufferid))::int as n
       from pg_buffercache where reldatabase = (select oid from pg_database where datname = current_database())`,
    );
    const { db, pool } = connect(appUrl, { max: 1 });
    try {
      await db.execute(sql`discard all`);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        const started = performance.now();
        await inTenant(db, (tx) => tx.execute(variant.query));
        runs.push(+(performance.now() - started).toFixed(1));
      }
      results.push({
        variant: variant.name,
        evictedBuffers: evicted.rows[0]?.n,
        runs,
      });
    } finally {
      await pool.end();
    }
  }
  return results;
}

// ---------------------------------------------------------------- export

const HEADER = [
  '接通时间',
  '主叫号码',
  '被叫号码',
  '国家/备注',
  '通话时长(秒)',
  '计费时长(分钟)',
  '费率',
  '费用',
  '通话UUID',
];
function csvLine(r: Record<string, unknown>): string {
  return [
    String(r.answered_bj),
    String(r.caller),
    String(r.callee),
    (r.country as string | null) ?? '',
    String(r.duration_seconds),
    String(r.billed_minutes),
    (r.rate as string | null) ?? '',
    String(r.charge),
    String(r.call_uuid),
  ]
    .map(quoteCsvCell)
    .join(',');
}
const exportQuery = (t: string) =>
  sql`select to_char(answered_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS') as answered_bj,
    ${COLUMNS} from cdrs where ${answeredWhere(t)} order by answered_at, call_uuid`;

/** 子进程：一次导出，输出耗时与峰值 RSS。 */
async function exportOnce(code: string, how: 'cursor' | 'naive', sink: string) {
  const tenant = tenants.find((t) => t.code === code);
  assert(tenant);
  const { db, pool } = connect(appUrl, { max: 1 });
  const rssBefore = process.memoryUsage().rss;
  let peakHeap = 0;
  const started = performance.now();
  let rows = 0;
  try {
    const out = createWriteStream(sink);
    const write = async (chunk: string) => {
      if (!out.write(chunk)) await once(out, 'drain');
    };
    await write('﻿' + HEADER.join(',') + '\r\n');
    await withTenant(db, tenant.id, async (tx) => {
      await applySettings(tx);
      if (how === 'cursor') {
        await tx.execute(
          sql`declare portal_export no scroll cursor for ${exportQuery(tenant.id)}`,
        );
        for (;;) {
          const batch = await rowsOf(
            tx,
            sql`fetch ${sql.raw(String(fetchSize))} from portal_export`,
          );
          if (batch.length === 0) break;
          rows += batch.length;
          await write(batch.map(csvLine).join('\r\n') + '\r\n');
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        }
      } else {
        const all = await rowsOf(tx, exportQuery(tenant.id));
        rows = all.length;
        const text = all.map(csvLine).join('\r\n') + '\r\n';
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
        await write(text);
      }
    });
    out.end();
    await once(out, 'finish');
  } finally {
    await pool.end();
  }
  const ms = performance.now() - started;
  process.stdout.write(
    JSON.stringify({
      code,
      how,
      fetchSize,
      settings,
      rows,
      ms: +ms.toFixed(0),
      rssBeforeMb: +(rssBefore / 2 ** 20).toFixed(1),
      maxRssMb: +(process.resourceUsage().maxRSS / 1024).toFixed(1),
      peakHeapMb: +(peakHeap / 2 ** 20).toFixed(1),
    }),
  );
}

async function measureExport() {
  const dir = resolve(tmpdir(), `portal-perf-${process.pid}`);
  await mkdir(dir, { recursive: true });
  const results = [];
  try {
    for (let round = 0; round < 3; round++)
      for (const how of ['cursor', 'naive'] as const)
        for (const tenant of tenants.filter((t) => t.shape === 'export')) {
          const sink = resolve(dir, `${tenant.code}-${how}.csv`);
          const line = await new Promise<string>((done, fail) => {
            const child = spawn(
              process.execPath,
              [
                ...process.execArgv,
                import.meta.filename,
                'export',
                tenant.code,
                how,
                sink,
              ],
              { stdio: ['ignore', 'pipe', 'inherit'] },
            );
            let text = '';
            child.stdout.on('data', (d: Buffer) => (text += d.toString()));
            child.on('exit', (code) =>
              code === 0
                ? done(text)
                : fail(new Error(`export exited ${code}`)),
            );
          });
          const result = JSON.parse(line) as { rows: number };
          assert.equal(result.rows, tenant.cdrs);
          const file = await readFile(sink, 'utf8');
          assert(file.startsWith('﻿接通时间,'));
          assert.equal(file.split('\r\n').length, tenant.cdrs + 2);
          results.push({ round, ...result, bytes: Buffer.byteLength(file) });
          process.stderr.write(`${JSON.stringify(results.at(-1))}\n`);
        }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await writeFile(
    resolve(output, 'export.json'),
    JSON.stringify(results, null, 2),
  );
  console.table(results);
}

const [command, ...args] = process.argv.slice(2);
if (command === 'seed') await seed();
else if (command === 'measure') await measure();
else if (command === 'export')
  await exportOnce(
    args[0]!,
    z.enum(['cursor', 'naive']).parse(args[1]),
    args[2]!,
  );
else throw new Error('usage: portal-perf.ts seed | measure');
