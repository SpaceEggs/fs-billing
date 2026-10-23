import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import {
  adminStatementsResponseSchema,
  adminStatementRegenerateResponseSchema,
  adminTenantStatementResponseSchema,
  adminTenantStatementsResponseSchema,
  portalStatementResponseSchema,
  portalStatementsResponseSchema,
} from '@fs-billing/shared';
import {
  connect,
  generateStatement,
  listMissingStatements,
  withSystem,
} from '@fs-billing/db';
import { createApi } from '../src/app.js';
import { createAuthGateway } from '../src/auth/gateway.js';

/**
 * 阶段 7：月账单接口经真实回环 HTTP 的耗时（PR 3 没有测，PR 6 补测，月账单取数优化后复测）。
 *
 * 目标库只能是阶段 6 性能库 fs_billing_perf_pr3_uuid_v4 的副本（CREATE DATABASE … TEMPLATE …），
 * 先用仓库的 migrate 脚本迁移到最新。脚本会改这个副本：删除旧的 48 行账单夹具、按 Worker 的路径补出全部月份、
 * 插入会话与门户账号。原库与其他性能库一概不碰（库名白名单见下）。
 *
 *   PERF_TARGET_DATABASE=fs_billing_perf_inv PERF_ROUNDS=7 \
 *   pnpm --filter @fs-billing/api exec tsx --env-file-if-exists=../../.env scripts/statements-perf-http.ts
 *
 * 副本准备好之后，`PERF_READS_ONLY=1` 只重复读取部分（不再补账单、不再生成），用来在同一个副本上
 * 交替比较两份代码；门户账号复用已有的，每次新建两个会话。
 */
const TARGET = process.env['PERF_TARGET_DATABASE'] ?? '';
// 只允许性能库的副本：不能是原库、快照库，也不能是开发库 fs_billing。
const PROTECTED_DATABASES = new Set([
  'fs_billing_perf',
  'fs_billing_perf_pr3_uuid_v4',
]);
assert(
  /^fs_billing_perf_[a-z0-9_]+$/.test(TARGET) &&
    !PROTECTED_DATABASES.has(TARGET) &&
    !TARGET.includes('snapshot'),
  `PERF_TARGET_DATABASE must be a copy such as fs_billing_perf_inv, got ${TARGET || '(unset)'}`,
);
const READS_ONLY = process.env['PERF_READS_ONLY'] === '1';
const ROUNDS = Number(process.env['PERF_ROUNDS'] ?? 7);
const WARMUPS = 2;
const BIG_TENANT = 'PORTALBIG';
const GENERATED_MONTH = '2026-09';
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
  const database = await owner.query<{
    current_database: string;
    version: string;
    migrations: string;
    cdrs: string;
  }>(`select current_database(), version(),
        (select count(*) from drizzle.__drizzle_migrations)::text as migrations,
        (select count(*) from cdrs where tenant_id = '00000000-0000-4000-8000-000000000001')::text as cdrs`);
  const info = database.rows[0]!;
  assert.equal(info.current_database, TARGET);
  out(
    `# Phase 7: statement endpoints over real loopback HTTP on the perf database copy${READS_ONLY ? ' (reads only, copy already prepared)' : ''}`,
  );
  out(
    `# ${new Date().toISOString()} database ${info.current_database} (copy of fs_billing_perf_pr3_uuid_v4, migrations applied: ${info.migrations}), ${BIG_TENANT} cdrs: ${info.cdrs}`,
  );
  out(`# ${info.version.split(',')[0]}`);
  out(
    `# transport: in-process Fastify app (createApi) on 127.0.0.1, node fetch, real cookie gateway, fs_billing_app business role, response body fully read and parsed; ${WARMUPS} warmups + ${ROUNDS} measured rounds`,
  );

  const tenantRows = await owner.query<{ id: string; code: string }>(
    `select id, code from tenants where code = $1`,
    [BIG_TENANT],
  );
  const big = tenantRows.rows[0]!;

  if (!READS_ONLY) {
    // 1. 旧夹具：迁移前留下的 48 行账单（只有头部），换成按 Worker 路径生成的账单。
    const removed = await owner.query('delete from monthly_statements');
    out(
      `# removed ${removed.rowCount} legacy fixture statements from the copy`,
    );

    // 2. 按 Worker 的路径（listMissingStatements + withSystem repeatable read 的 generateStatement）补出
    //    除 BIG_TENANT 的 2026-09 之外的全部月份；这一个月留给下面的 HTTP 生成。
    const missing = await withSystem(db, (tx) => listMissingStatements(tx));
    out(
      `# missing statements before generation: ${missing.length} (tenants with a first month through the previous Beijing month)`,
    );
    const workerBig: { month: string; ms: number; outcome: string }[] = [];
    let others = 0;
    let othersMs = 0;
    for (const entry of missing) {
      if (entry.tenantId === big.id && entry.month.startsWith(GENERATED_MONTH))
        continue;
      const started = performance.now();
      const result = await withSystem(
        db,
        (tx) => generateStatement(tx, entry.tenantId, entry.month),
        { isolationLevel: 'repeatable read' },
      );
      const elapsed = performance.now() - started;
      if (entry.tenantId === big.id)
        workerBig.push({
          month: entry.month.slice(0, 7),
          ms: ms(elapsed),
          outcome: result.outcome,
        });
      else {
        others += 1;
        othersMs += elapsed;
      }
    }
    out('');
    out(
      `## Worker path (generateStatement in a repeatable read withSystem transaction), ${BIG_TENANT}, run order oldest month first, cold start`,
    );
    for (const row of workerBig)
      out(`worker generate ${row.month}: ${row.ms} ms (${row.outcome})`);
    out(
      `worker generate other tenants: ${others} statements, total ${ms(othersMs)} ms`,
    );
  }

  // 3. 会话：管理员（已有）与 PORTALBIG 的门户账号（性能库里没有，在副本里新建）。
  const admin = (
    await owner.query<{ auth_user_id: string }>(
      "select auth_user_id from admins where status='active' order by id limit 1",
    )
  ).rows[0];
  assert(admin, 'active administrator required');
  // 每个租户只能有一个门户账号：重复运行（PERF_READS_ONLY）复用上一次建的那个。
  const existingPortal = (
    await owner.query<{ auth_user_id: string }>(
      "select auth_user_id from portal_accounts where tenant_id = $1 and status = 'active' limit 1",
      [big.id],
    )
  ).rows[0];
  const portalUserId =
    existingPortal?.auth_user_id ?? `statements-perf-${randomUUID()}`;
  if (!existingPortal) {
    await owner.query(
      `insert into auth."user"(id, name, email, email_verified) values ($1, 'statements perf portal', $2, false)`,
      [portalUserId, `${portalUserId}@example.invalid`],
    );
    await owner.query(
      `insert into portal_accounts(id, auth_user_id, tenant_id, status) values ($1::uuid, $2, $3::uuid, 'active')`,
      [randomUUID(), portalUserId, big.id],
    );
  }
  const sessions: Record<'admin' | 'portal', string> = {
    admin: '',
    portal: '',
  };
  for (const [kind, userId] of [
    ['admin', admin.auth_user_id],
    ['portal', portalUserId],
  ] as const) {
    const token = randomBytes(32).toString('base64url');
    await authPool.query(
      `insert into auth.session(id,token,user_id,expires_at,created_at,updated_at)
       values($1,$2,$3,clock_timestamp()+interval '2 hours',clock_timestamp(),clock_timestamp())`,
      [randomUUID(), token, userId],
    );
    sessions[kind] = cookieFor(token, secret);
  }
  const origin = await api.listen({ host: '127.0.0.1', port: 0 });

  type Result = { status: number; bytes: number; text: string };
  const call = async (
    kind: 'admin' | 'portal',
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<Result & { ms: number }> => {
    const started = performance.now();
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        cookie: sessions[kind],
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      ms: performance.now() - started,
      status: response.status,
      bytes: Buffer.byteLength(text),
      text,
    };
  };

  const report = (
    label: string,
    samples: { ms: number; bytes: number }[],
    note = '',
  ) => {
    const times = samples.map((sample) => sample.ms);
    out(
      `${label}: n=${times.length} min ${ms(Math.min(...times))} median ${ms(median(times))} max ${ms(Math.max(...times))} ms, response ${samples[0]!.bytes} bytes${note ? `, ${note}` : ''}`,
    );
    out(`  samples ms: ${times.map((time) => ms(time)).join(', ')}`);
  };

  const measure = async (
    label: string,
    kind: 'admin' | 'portal',
    method: 'GET' | 'POST',
    path: string,
    check: (text: string) => string,
    body?: unknown,
  ) => {
    const samples: { ms: number; bytes: number }[] = [];
    let note = '';
    for (let round = -WARMUPS; round < ROUNDS; round++) {
      const result = await call(kind, method, path, body);
      assert.equal(
        result.status,
        200,
        `${label}: ${result.text.slice(0, 300)}`,
      );
      note = check(result.text);
      if (round >= 0) samples.push(result);
    }
    report(label, samples, note);
  };

  const portalList = (text: string) => {
    const body = portalStatementsResponseSchema.parse(JSON.parse(text));
    return `${body.items.length} rows (${body.items.map((item) => item.state).join('/')})`;
  };
  const portalDetail = (text: string) => {
    const body = portalStatementResponseSchema.parse(JSON.parse(text));
    return `state ${body.state}, ${body.countries.length} countries, ${body.days.length} days`;
  };
  const countLines = (text: string) =>
    `${text.split('\n').length - 1} CSV lines`;

  if (!READS_ONLY) {
    // 4. 生成前：2026-09 还没有账单，列表里是实时算的待生成行，详情也是实时的。
    out('');
    out(
      `## Before the ${GENERATED_MONTH} statement of ${BIG_TENANT} exists (that month is pending and computed live)`,
    );
    for (let i = 1; i <= 3; i++) {
      const result = await call('portal', 'GET', '/api/portal/statements');
      assert.equal(result.status, 200, result.text.slice(0, 300));
      out(
        `portal list, pending month computed live, run ${i}: ${ms(result.ms)} ms, ${portalList(result.text)}`,
      );
    }
    for (let i = 1; i <= 3; i++) {
      const result = await call(
        'portal',
        'GET',
        `/api/portal/statements/${GENERATED_MONTH}`,
      );
      assert.equal(result.status, 200, result.text.slice(0, 300));
      out(
        `portal detail ${GENERATED_MONTH} pending (live), run ${i}: ${ms(result.ms)} ms, ${portalDetail(result.text)}`,
      );
    }
  }

  // 5. 3M 租户的一次生成，端到端（后台「重新生成」补建：expectedVersion 0）。
  out('');
  out(
    `## Statement generation for ${BIG_TENANT} (${info.cdrs} cdrs) over HTTP: POST /api/admin/tenants/{id}/statements/${GENERATED_MONTH}/regenerate`,
  );
  const regenerate = async (expectedVersion: number) => {
    const result = await call(
      'admin',
      'POST',
      `/api/admin/tenants/${big.id}/statements/${GENERATED_MONTH}/regenerate`,
      { expectedVersion },
    );
    assert.equal(result.status, 200, result.text.slice(0, 300));
    const body = adminStatementRegenerateResponseSchema.parse(
      JSON.parse(result.text),
    );
    return { ...result, body };
  };
  if (!READS_ONLY) {
    const created = await regenerate(0);
    out(
      `create (expectedVersion 0): ${ms(created.ms)} ms, created ${String(created.body.created)}, changed ${String(created.body.changed)}, version ${created.body.after.version}, response ${created.bytes} bytes`,
    );
  }
  const again: number[] = [];
  for (let i = 0; i < 5; i++) {
    const result = await regenerate(1);
    again.push(result.ms);
    assert.equal(result.body.changed, false);
  }
  out(
    `regenerate unchanged (expectedVersion 1, 3M-row month recomputed, no new version), 5 runs ms: ${again.map((time) => ms(time)).join(', ')}`,
  );

  // 6. 读取。
  out('');
  out('## Reads');
  await measure(
    'portal list GET /api/portal/statements',
    'portal',
    'GET',
    '/api/portal/statements',
    portalList,
  );
  await measure(
    `portal detail stored ${GENERATED_MONTH} (3M tenant, ${GENERATED_MONTH} has 234,277 answered calls)`,
    'portal',
    'GET',
    `/api/portal/statements/${GENERATED_MONTH}`,
    portalDetail,
  );
  await measure(
    'portal detail stored 2026-08',
    'portal',
    'GET',
    '/api/portal/statements/2026-08',
    portalDetail,
  );
  await measure(
    'portal detail in-progress 2026-10 (live aggregation)',
    'portal',
    'GET',
    '/api/portal/statements/2026-10',
    portalDetail,
  );
  await measure(
    `portal summary CSV export POST /api/portal/statements/${GENERATED_MONTH}/export`,
    'portal',
    'POST',
    `/api/portal/statements/${GENERATED_MONTH}/export`,
    countLines,
  );
  await measure(
    `admin month list GET /api/admin/statements?month=${GENERATED_MONTH} (all tenants)`,
    'admin',
    'GET',
    `/api/admin/statements?month=${GENERATED_MONTH}`,
    (text) => {
      const body = adminStatementsResponseSchema.parse(JSON.parse(text));
      return `${body.groups.reduce((sum, group) => sum + group.items.length, 0)} tenant rows in ${body.groups.length} currency groups`;
    },
  );
  await measure(
    'admin month list GET /api/admin/statements?month=2026-08',
    'admin',
    'GET',
    '/api/admin/statements?month=2026-08',
    (text) => {
      const body = adminStatementsResponseSchema.parse(JSON.parse(text));
      return `${body.groups.reduce((sum, group) => sum + group.items.length, 0)} tenant rows`;
    },
  );
  await measure(
    `admin tenant statements tab GET /api/admin/tenants/{id}/statements (${BIG_TENANT})`,
    'admin',
    'GET',
    `/api/admin/tenants/${big.id}/statements`,
    (text) =>
      `${adminTenantStatementsResponseSchema.parse(JSON.parse(text)).items.length} rows`,
  );
  await measure(
    `admin tenant statement detail ${GENERATED_MONTH} (${BIG_TENANT})`,
    'admin',
    'GET',
    `/api/admin/tenants/${big.id}/statements/${GENERATED_MONTH}`,
    (text) => {
      const body = adminTenantStatementResponseSchema.parse(JSON.parse(text));
      return `${body.countries.length} countries, ${body.days.length} days`;
    },
  );
  await measure(
    `admin summary CSV export POST /api/admin/tenants/{id}/statements/${GENERATED_MONTH}/export`,
    'admin',
    'POST',
    `/api/admin/tenants/${big.id}/statements/${GENERATED_MONTH}/export`,
    countLines,
  );
  out('');
  out('done: 0 errors');
} finally {
  await api.close();
  await authPool.end();
  await owner.end();
  const { writeFileSync } = await import('node:fs');
  const target = process.env['PERF_OUTPUT'];
  if (target) writeFileSync(target, `${lines.join('\n')}\n`);
}
