import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  adminAlertSettingsResponseSchema,
  adminOverviewResponseSchema,
  adminSystemAlertDetailSchema,
  adminSystemAlertsResponseSchema,
  adminSystemAlertsSummaryResponseSchema,
} from '@fs-billing/shared';
import { connect } from '@fs-billing/db';
import { createApi } from '../src/app.js';
import { createAuthGateway } from '../src/auth/gateway.js';

/**
 * 阶段 9 PR 6：概览与系统告警接口经真实回环 HTTP 的耗时（设计「性能」一节）：
 * - `GET /api/admin/overview` 在 PORTALBIG 形状的库上（300 万话单、285 万笔流水），含近 30 天按币种的消费聚合、
 *   今日 / 本月聚合、待收款、租户状态、未归属、告警；
 * - `auth_timeout` 告警详情按租户统计 `cdrs.unverified`（范围最长 30 天）；
 * - 告警列表（10 万行 system_alerts）与汇总、设置。
 *
 * 会写库：只允许 fs_billing_perf_ 开头的库（PERF_TARGET_DATABASE），把 PORTALBIG 的话单与流水补到「现在」
 * （其中 0.5% 话单为未验证），把 system_alerts 补到 10 万行。库用 `balance-notice-perf.ts setup` 建（见该文件头注释）。
 *
 *   PERF_TARGET_DATABASE=fs_billing_perf_p9pr6 PERF_ROUNDS=7 \
 *   pnpm --filter @fs-billing/api exec tsx --env-file-if-exists=../../.env scripts/overview-perf-http.ts
 */
const TARGET = process.env['PERF_TARGET_DATABASE'] ?? '';
const PROTECTED_DATABASES = new Set([
  'fs_billing_perf',
  'fs_billing_perf_pr3_uuid_v4',
]);
assert(
  /^fs_billing_perf_[a-z0-9_]+$/.test(TARGET) &&
    !PROTECTED_DATABASES.has(TARGET) &&
    !TARGET.includes('snapshot'),
  `PERF_TARGET_DATABASE must be a copy such as fs_billing_perf_p9pr6, got ${TARGET || '(unset)'}`,
);
const ROUNDS = Number(process.env['PERF_ROUNDS'] ?? 7);
const WARMUPS = 2;
const ALERT_ROWS = 100_000;
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

function targetUrl(value: string | undefined, role: string) {
  assert(value, `missing ${role} url`);
  const url = new URL(value);
  assert(localHosts.has(url.hostname), 'database must be local');
  assert.equal(decodeURIComponent(url.username), role);
  url.pathname = `/${TARGET}`;
  return url.toString();
}
const ownerUrl = targetUrl(process.env['DATABASE_URL'], 'fs_billing');
const appUrl = targetUrl(process.env['APP_DATABASE_URL'], 'fs_billing_app');
const authUrl = targetUrl(process.env['AUTH_DATABASE_URL'], 'fs_billing_auth');

const lines: string[] = [];
const out = (line: string) => {
  lines.push(line);
  console.log(line);
};
const ms = (value: number) => Number(value.toFixed(1));
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
function cookieFor(token: string, secret: string) {
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

const owner = new pg.Client({ connectionString: ownerUrl });
await owner.connect();
const authPool = new pg.Pool({ connectionString: authUrl, max: 1 });
const { db } = connect(appUrl, { max: 4 });
const secret = randomBytes(32).toString('base64url');
const auth = createAuthGateway({
  pool: authPool,
  secret,
  baseURL: 'http://localhost:3000',
  secureCookies: false,
  trustedOrigins: ['http://localhost:3000'],
  logger: { info: () => undefined, error: () => undefined },
});
const api = createApi({ businessDb: db, auth, mailEnabled: true });

try {
  const info = (
    await owner.query<{ current_database: string; version: string }>(
      'select current_database(), version()',
    )
  ).rows[0]!;
  assert.equal(info.current_database, TARGET);
  out(
    '# Phase 9 PR 6: admin overview and system alerts over real loopback HTTP on a PORTALBIG-shaped perf database',
  );
  out(`# ${new Date().toISOString()} database ${info.current_database}`);
  out(`# ${info.version.split(',')[0]}`);
  out(
    `# transport: in-process Fastify app (createApi) on 127.0.0.1, node fetch, real cookie gateway, fs_billing_app business role, response body fully read and parsed with the contract schema; ${WARMUPS} warmups + ${ROUNDS} measured rounds`,
  );

  const adminRow = (
    await owner.query<{ id: string; auth_user_id: string }>(
      "select id, auth_user_id from admins where status = 'active' order by id limit 1",
    )
  ).rows[0];
  assert(adminRow, 'active administrator required');

  // 夹具一：PORTALBIG 的话单与流水补到现在（建库脚本的数据停在 2026-10 中旬），0.5% 话单未验证。
  const big = (
    await owner.query<{ id: string }>(
      "select id from tenants where code = 'PORTALBIG'",
    )
  ).rows[0]!.id;
  const last = (
    await owner.query<{ ledger: Date; cdr: Date }>(
      `select (select max(occurred_at) from ledger_entries where tenant_id = $1) as ledger,
              (select max(started_at) from cdrs where tenant_id = $1) as cdr`,
      [big],
    )
  ).rows[0]!;
  const nowRow = (await owner.query<{ now: Date }>('select now() as now'))
    .rows[0]!;
  if (nowRow.now.getTime() - last.ledger.getTime() > 3_600_000) {
    const started = performance.now();
    await owner.query('set session_replication_role = replica');
    const { rows: months } = await owner.query<{ month: string }>(
      `select distinct to_char(d, 'YYYY-MM-01') as month
       from generate_series($1::timestamptz, now(), interval '1 day') d`,
      [last.cdr],
    );
    for (const { month } of months) {
      const next = (
        await owner.query<{ next: string }>(
          `select to_char($1::date + interval '1 month', 'YYYY-MM-DD') as next`,
          [month],
        )
      ).rows[0]!.next;
      const name = `cdrs_${month.slice(0, 7).replace('-', '_')}`;
      const exists = (
        await owner.query(`select 1 from pg_class where relname = $1`, [name])
      ).rowCount;
      if (!exists)
        await owner.query(
          `create table ${name} partition of cdrs for values from ('${month}') to ('${next}')`,
        );
    }
    await owner.query(
      `insert into cdrs (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee, billing_number,
                         duration_seconds, billed_minutes, matched_prefix, country, rate, charge, hangup_cause,
                         unverified, received_at)
       select $1, gen_random_uuid(), ts,
              case when g % 20 = 0 then null else ts + interval '3 seconds' end,
              ts + interval '70 seconds', '075586001234', '+8613800' || lpad((g % 100000)::text, 6, '0'),
              '8613800' || lpad((g % 100000)::text, 6, '0'),
              case when g % 20 = 0 then 0 else 61 end, case when g % 20 = 0 then 0 else 2 end,
              case when g % 20 = 0 then null else '86' end, case when g % 20 = 0 then null else '中国' end,
              case when g % 20 = 0 then null else 0.05 end, case when g % 20 = 0 then 0 else 0.1 end, 'NORMAL_CLEARING',
              g % 200 = 0, ts + interval '75 seconds'
       from (select g, $2::timestamptz + g * interval '10.5 seconds' as ts
             from generate_series(1, (extract(epoch from (now() - $2::timestamptz)) / 10.5)::int) g) s`,
      [big, last.cdr],
    );
    await owner.query(
      `insert into ledger_entries (tenant_id, kind, amount, note, created_by, idempotency_key, occurred_at, created_at)
       select $1, 'call_charge', -(0.05 + (g % 7) * 0.01), 'perf', null, 'perf-p9pr6:' || g,
              $2::timestamptz + g * interval '11 seconds', $2::timestamptz + g * interval '11 seconds'
       from generate_series(1, (extract(epoch from (now() - $2::timestamptz)) / 11)::int) g`,
      [big, last.ledger],
    );
    await owner.query('set session_replication_role = origin');
    out(
      `# topped up PORTALBIG cdrs and ledger from ${last.cdr.toISOString()} to now (${ms(performance.now() - started)} ms)`,
    );
  }

  // 夹具二：10 万行 system_alerts（绝大多数是已恢复的历史），30 条进行中；一条持续 40 天的进行中 auth_timeout。
  const alerts = (
    await owner.query<{ n: number }>(
      'select count(*)::int as n from system_alerts',
    )
  ).rows[0]!.n;
  if (alerts < ALERT_ROWS) {
    await owner.query(
      `insert into system_alerts (kind, subject_key, description, started_at, last_seen_at, recovered_at, affected_calls, notify)
       select (array['cdr_failed','partition_failed','statement_mismatch','audit_failed','raw_archive_failed'])[1 + g % 5],
              'perf:' || g, '性能夹具 ' || g,
              now() - (g * interval '4 minutes'), now() - (g * interval '4 minutes'),
              case when g <= 30 then null else now() - (g * interval '4 minutes') + interval '10 minutes' end,
              g % 50, false
       from generate_series(1, $1::int) g`,
      [ALERT_ROWS - alerts],
    );
    await owner.query(
      `insert into system_alerts (kind, subject_key, description, started_at, last_seen_at, affected_calls, notify)
       values ('auth_timeout', 'fs-authorize', '授权接口超时放行', now() - interval '40 days', now(), 123456, true)
       on conflict do nothing`,
    );
  }
  await owner.query('analyze system_alerts');
  await owner.query('analyze cdrs');
  await owner.query('analyze ledger_entries');
  const counts = (
    await owner.query<{
      cdrs: number;
      ledger: number;
      unverified: number;
      alerts: number;
      open: number;
      tenants: number;
    }>(
      `select (select count(*)::int from cdrs) as cdrs, (select count(*)::int from ledger_entries) as ledger,
              (select count(*)::int from cdrs where unverified) as unverified,
              (select count(*)::int from system_alerts) as alerts,
              (select count(*)::int from system_alerts where recovered_at is null) as open,
              (select count(*)::int from tenants) as tenants`,
    )
  ).rows[0]!;
  out(
    `# data: ${counts.cdrs} cdrs (${counts.unverified} unverified), ${counts.ledger} ledger entries, ${counts.tenants} tenants, ${counts.alerts} system alerts (${counts.open} open)`,
  );
  const authAlert = (
    await owner.query<{ id: string }>(
      "select id from system_alerts where kind = 'auth_timeout' and recovered_at is null limit 1",
    )
  ).rows[0]!.id;

  const token = randomBytes(32).toString('base64url');
  await authPool.query(
    `insert into auth.session(id,token,user_id,expires_at,created_at,updated_at)
     values($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp(),clock_timestamp())`,
    [randomUUID(), token, adminRow.auth_user_id],
  );
  const cookie = cookieFor(token, secret);
  const origin = await api.listen({ host: '127.0.0.1', port: 0 });

  const call = async (path: string) => {
    const started = performance.now();
    const response = await fetch(`${origin}${path}`, { headers: { cookie } });
    const text = await response.text();
    return {
      ms: performance.now() - started,
      status: response.status,
      bytes: Buffer.byteLength(text),
      text,
    };
  };
  const measure = async (
    label: string,
    path: string,
    check: (body: unknown) => string,
  ) => {
    const samples: { ms: number; bytes: number }[] = [];
    let note = '';
    for (let round = -WARMUPS; round < ROUNDS; round++) {
      const result = await call(path);
      assert.equal(
        result.status,
        200,
        `${label}: ${result.text.slice(0, 300)}`,
      );
      note = check(JSON.parse(result.text));
      if (round >= 0) samples.push(result);
    }
    const times = samples.map((sample) => sample.ms);
    out(
      `${label}: n=${times.length} min ${ms(Math.min(...times))} median ${ms(median(times))} max ${ms(Math.max(...times))} ms, response ${samples[0]!.bytes} bytes, ${note}`,
    );
    out(`  samples ms: ${times.map((time) => ms(time)).join(', ')}`);
  };

  out('');
  out('## Overview');
  await measure('GET /api/admin/overview', '/api/admin/overview', (body) => {
    const parsed = adminOverviewResponseSchema.parse(body);
    return `today CNY ${parsed.metrics.todaySpend.CNY}, month CNY ${parsed.metrics.monthSpend.CNY}, ${parsed.metrics.todayCallMinutes} minutes, alerts open ${parsed.attention.alerts.open} / 24h ${parsed.attention.alerts.last24h}`;
  });

  out('');
  out('## System alerts');
  await measure(
    'GET /api/admin/system-alerts/summary',
    '/api/admin/system-alerts/summary',
    (body) => {
      const parsed = adminSystemAlertsSummaryResponseSchema.parse(body);
      return `open ${parsed.open}, last24h ${parsed.last24h}`;
    },
  );
  const list = (body: unknown) => {
    const parsed = adminSystemAlertsResponseSchema.parse(body);
    return `${parsed.items.length} rows of ${parsed.pagination.total}`;
  };
  await measure(
    'GET /api/admin/system-alerts?window=24h',
    '/api/admin/system-alerts?window=24h',
    list,
  );
  await measure(
    'GET /api/admin/system-alerts (default: 30d, page 1)',
    '/api/admin/system-alerts',
    list,
  );
  await measure(
    'GET /api/admin/system-alerts?window=all&page=2000&pageSize=50 (offset 99,950)',
    '/api/admin/system-alerts?window=all&page=2000&pageSize=50',
    list,
  );
  await measure(
    'GET /api/admin/system-alerts?window=all&status=open&kind=auth_timeout',
    '/api/admin/system-alerts?window=all&status=open&kind=auth_timeout',
    list,
  );
  await measure(
    'GET /api/admin/system-alerts/{auth_timeout, open 40 days, capped at 30 days}',
    `/api/admin/system-alerts/${authAlert}`,
    (body) => {
      const parsed = adminSystemAlertDetailSchema.parse(body);
      return `${parsed.affectedTenants?.items.map((item) => `${item.code}:${item.count}`).join(' ')}, truncated ${parsed.affectedTenants?.truncated}, range ${parsed.cdrRange?.fromDay}..${parsed.cdrRange?.toDay}`;
    },
  );
  await measure(
    'GET /api/admin/alert-settings',
    '/api/admin/alert-settings',
    (body) => {
      const parsed = adminAlertSettingsResponseSchema.parse(body);
      return `version ${parsed.version}, mailEnabled ${parsed.mailEnabled}`;
    },
  );
} finally {
  await api.close();
  await authPool.end();
  await owner.end();
}
const file = process.env['PERF_OUTPUT'];
if (file) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(file, `${lines.join('\n')}\n`);
}
