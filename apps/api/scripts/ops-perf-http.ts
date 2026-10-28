import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  adminAuditLogsResponseSchema,
  adminCdrDeletionMonthsResponseSchema,
  adminUnassignedGroupsResponseSchema,
  adminUnassignedListResponseSchema,
  adminUnassignedSummaryResponseSchema,
} from '@fs-billing/shared';
import { connect } from '@fs-billing/db';
import { createApi } from '../src/app.js';
import { createAuthGateway } from '../src/auth/gateway.js';

/**
 * 阶段 8 PR 4：未归属话单列表 / 分组与操作日志列表经真实回环 HTTP 的耗时。
 * PR 1 测的是 SQL 形状（docs/evidence/phase-8），这里加上接口的全部开销：路由、认证与身份解析、
 * 事务、分组里的相近租户计算、响应校验与序列化、fetch 读完并解析整个响应。
 *
 * 会写库：只允许在 fs_billing_perf 的克隆库上运行（库名白名单见下），把 unassigned_cdrs 补到 10 万行待处理
 * （40 个标签）加 2000 行已忽略，把 operation_logs 补到 100 万行（最近一年，带真实形状的 details）。
 *
 *   CREATE DATABASE fs_billing_perf_p8pr4 TEMPLATE fs_billing_perf;  然后对它执行 pnpm db:migrate
 *   PERF_TARGET_DATABASE=fs_billing_perf_p8pr4 PERF_ROUNDS=7 \
 *   pnpm --filter @fs-billing/api exec tsx --env-file-if-exists=../../.env scripts/ops-perf-http.ts
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
  `PERF_TARGET_DATABASE must be a copy such as fs_billing_perf_p8pr4, got ${TARGET || '(unset)'}`,
);
const ROUNDS = Number(process.env['PERF_ROUNDS'] ?? 7);
const WARMUPS = 2;
const PENDING_ROWS = 100_000;
const LOG_ROWS = 1_000_000;
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
const api = createApi({ businessDb: db, auth });

try {
  const info = (
    await owner.query<{
      current_database: string;
      version: string;
      migrations: string;
    }>(`select current_database(), version(),
          (select count(*) from drizzle.__drizzle_migrations)::text as migrations`)
  ).rows[0]!;
  assert.equal(info.current_database, TARGET);
  out(
    '# Phase 8 PR 4: unassigned list / groups and operation log list over real loopback HTTP on a perf database copy',
  );
  out(
    `# ${new Date().toISOString()} database ${info.current_database} (copy of fs_billing_perf, migrations applied: ${info.migrations})`,
  );
  out(`# ${info.version.split(',')[0]}`);
  out(
    `# transport: in-process Fastify app (createApi) on 127.0.0.1, node fetch, real cookie gateway, fs_billing_app business role, response body fully read and parsed with the contract schema; ${WARMUPS} warmups + ${ROUNDS} measured rounds`,
  );

  const adminRow = (
    await owner.query<{ id: string; auth_user_id: string; name: string }>(
      "select id, auth_user_id, name from admins where status = 'active' order by id limit 1",
    )
  ).rows[0];
  assert(adminRow, 'active administrator required');
  const tenant = (
    await owner.query<{ id: string; code: string }>(
      "select id, code from tenants where code = 'PORTALBIG'",
    )
  ).rows[0]!;

  // 夹具：与 PR 1 的 SQL 形状测量同一份数据。
  const pending = (
    await owner.query<{ n: number }>(
      "select count(*)::int as n from unassigned_cdrs where status = 'pending'",
    )
  ).rows[0]!.n;
  if (pending < PENDING_ROWS) {
    const started = performance.now();
    await owner.query(
      `insert into unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, answered_at, ended_at, caller, callee,
         billing_number, duration_seconds, hangup_cause)
       select 'TAG' || lpad((g % 40)::text, 2, '0'), gen_random_uuid(),
         (array['租户不存在','缺少租户标签','接通时无费率'])[1 + g % 3],
         '2026-09-01 00:00:00+08'::timestamptz + (g * interval '23 seconds'),
         '2026-09-01 00:00:03+08'::timestamptz + (g * interval '23 seconds'),
         '2026-09-01 00:01:03+08'::timestamptz + (g * interval '23 seconds'),
         '075586001234', '+8613800138000', '8613800138000', 60, 'NORMAL_CLEARING'
       from generate_series(1, $1::int) g`,
      [PENDING_ROWS - pending],
    );
    out(
      `# unassigned_cdrs filled to ${PENDING_ROWS} pending rows (${PENDING_ROWS - pending} inserted, ${ms(performance.now() - started)} ms)`,
    );
  }
  const ignored = (
    await owner.query<{ n: number }>(
      "select count(*)::int as n from unassigned_cdrs where status = 'ignored'",
    )
  ).rows[0]!.n;
  if (ignored < 2000) {
    await owner.query(
      `insert into unassigned_cdrs (tenant_tag, call_uuid, reason, started_at, answered_at, ended_at, caller, callee,
         billing_number, duration_seconds, hangup_cause, status, ignore_reason, resolved_by, resolved_at)
       select 'TEST' || lpad((g % 4)::text, 2, '0'), gen_random_uuid(), '租户不存在',
         '2026-09-02 00:00:00+08'::timestamptz + (g * interval '23 seconds'),
         '2026-09-02 00:00:03+08'::timestamptz + (g * interval '23 seconds'),
         '2026-09-02 00:01:03+08'::timestamptz + (g * interval '23 seconds'),
         '075586001234', '+8613800138000', '8613800138000', 60, 'NORMAL_CLEARING',
         'ignored', '测试呼叫', $2::uuid, now()
       from generate_series(1, $1::int) g`,
      [2000 - ignored, adminRow.id],
    );
  }
  await owner.query('analyze unassigned_cdrs');

  const logs = (
    await owner.query<{ n: number }>(
      'select count(*)::int as n from operation_logs',
    )
  ).rows[0]!.n;
  if (logs < LOG_ROWS) {
    const started = performance.now();
    await owner.query(
      `insert into operation_logs (admin_id, tenant_id, action, target, details, created_at)
       select (select id from admins order by id limit 1 offset (g % 2)),
         (select id from tenants order by id limit 1 offset (g % 17)),
         a.action, gen_random_uuid()::text,
         jsonb_build_object(
           'actor', jsonb_build_object('id', gen_random_uuid(), 'name', 'perf'),
           'target', jsonb_build_object('kind', 'tenant', 'id', gen_random_uuid()),
           'content', jsonb_build_object('summary', '性能夹具 ' || a.action,
             'changes', jsonb_build_array(jsonb_build_object('field', 'name', 'before', 'old', 'after', 'new')))),
         date_trunc('day', now()) - interval '364 days' + (g * interval '31 seconds')
       from generate_series(1, $1::int) g
       cross join lateral (select (array['tenant_edit','balance_topup','rate_entry_edit','rate_import','receivable_confirm',
         'statement_regenerate','unassigned_assign','cdr_delete','reset_password','balance_adjustment'])[1 + g % 10] as action) a`,
      [LOG_ROWS - logs],
    );
    out(
      `# operation_logs filled to ${LOG_ROWS} rows over the last year (${LOG_ROWS - logs} inserted, ${ms(performance.now() - started)} ms)`,
    );
  }
  await owner.query('analyze operation_logs');
  const counts = (
    await owner.query<{ pending: number; ignored: number; logs: number }>(
      `select (select count(*)::int from unassigned_cdrs where status = 'pending') as pending,
              (select count(*)::int from unassigned_cdrs where status = 'ignored') as ignored,
              (select count(*)::int from operation_logs) as logs`,
    )
  ).rows[0]!;
  out(
    `# data: ${counts.pending} pending and ${counts.ignored} ignored unassigned rows, ${counts.logs} operation log rows`,
  );

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
  out('## Unassigned CDRs');
  await measure(
    'GET /api/admin/unassigned-cdrs/summary',
    '/api/admin/unassigned-cdrs/summary',
    (body) => {
      const parsed = adminUnassignedSummaryResponseSchema.parse(body);
      return `pending ${parsed.pending}, ignored ${parsed.ignored}`;
    },
  );
  await measure(
    'GET /api/admin/unassigned-cdrs/groups (100k pending rows)',
    '/api/admin/unassigned-cdrs/groups',
    (body) => {
      const parsed = adminUnassignedGroupsResponseSchema.parse(body);
      return `${parsed.groups.length} groups, total ${parsed.total}`;
    },
  );
  const list = (body: unknown) => {
    const parsed = adminUnassignedListResponseSchema.parse(body);
    return `${parsed.items.length} rows of ${parsed.pagination.total}`;
  };
  await measure(
    'GET /api/admin/unassigned-cdrs?pageSize=50 (page 1)',
    '/api/admin/unassigned-cdrs?pageSize=50',
    list,
  );
  await measure(
    'GET /api/admin/unassigned-cdrs?pageSize=50&page=1000 (offset 49,950)',
    '/api/admin/unassigned-cdrs?pageSize=50&page=1000',
    list,
  );
  await measure(
    'GET /api/admin/unassigned-cdrs?tag=TAG07&pageSize=50',
    '/api/admin/unassigned-cdrs?tag=TAG07&pageSize=50',
    list,
  );
  await measure(
    'GET /api/admin/unassigned-cdrs?status=ignored&pageSize=50',
    '/api/admin/unassigned-cdrs?status=ignored&pageSize=50',
    list,
  );

  out('');
  out('## Operation log (1M rows over the last year)');
  const auditList = (body: unknown) => {
    const parsed = adminAuditLogsResponseSchema.parse(body);
    return `${parsed.items.length} rows of ${parsed.pagination.total} (${parsed.range.from} .. ${parsed.range.to})`;
  };
  await measure(
    'GET /api/admin/audit-logs (default: last 30 days, 50 rows)',
    '/api/admin/audit-logs',
    auditList,
  );
  await measure(
    `GET /api/admin/audit-logs?tenantId=… (one tenant, last 30 days)`,
    `/api/admin/audit-logs?tenantId=${tenant.id}`,
    auditList,
  );
  await measure(
    'GET /api/admin/audit-logs?label=cdr_delete (last 30 days)',
    '/api/admin/audit-logs?label=cdr_delete',
    auditList,
  );
  await measure(
    'GET /api/admin/audit-logs?label=rate&tenantId=…&adminId=… (last 30 days)',
    `/api/admin/audit-logs?label=rate&tenantId=${tenant.id}&adminId=${adminRow.id}`,
    auditList,
  );
  const yearFrom = new Date(Date.now() + 8 * 3600_000 - 364 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  await measure(
    `GET /api/admin/audit-logs?from=${yearFrom} (whole year, page 1)`,
    `/api/admin/audit-logs?from=${yearFrom}`,
    auditList,
  );
  await measure(
    `GET /api/admin/audit-logs?from=${yearFrom}&page=2001 (whole year, offset 100,000)`,
    `/api/admin/audit-logs?from=${yearFrom}&page=2001`,
    auditList,
  );
  await measure(
    `GET /api/admin/audit-logs?from=${yearFrom}&label=unassigned_assign&pageSize=100`,
    `/api/admin/audit-logs?from=${yearFrom}&label=unassigned_assign&pageSize=100`,
    auditList,
  );

  out('');
  out('## Deletion month grid (3.4M cdrs tenant)');
  await measure(
    `GET /api/admin/tenants/{PORTALBIG}/cdr-deletions?year=2026`,
    `/api/admin/tenants/${tenant.id}/cdr-deletions?year=2026`,
    (body) => {
      const parsed = adminCdrDeletionMonthsResponseSchema.parse(body);
      return parsed.months
        .map((month) => `${month.month.slice(5)}:${month.state}`)
        .join(' ');
    },
  );
} finally {
  await api.close();
  await authPool.end();
  await owner.end();
}
const dir = process.env['PERF_OUTPUT'];
if (dir) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(dir, `${lines.join('\n')}\n`);
}
