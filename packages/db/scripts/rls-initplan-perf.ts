import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, loadavg, platform, release, totalmem, uptime } from 'node:os';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { z } from 'zod';

type QueryCase = {
  readonly name: string;
  readonly sql: string;
  readonly nonEmpty: (rows: readonly Record<string, unknown>[]) => boolean;
};

const policySchema = z.object({
  schemaname: z.string(),
  tablename: z.string(),
  policyname: z.string(),
  permissive: z.string(),
  roles: z.array(z.string()),
  cmd: z.string(),
  qual: z.string().nullable(),
  with_check: z.string().nullable(),
});
type Policy = z.infer<typeof policySchema>;

type PlanNode = {
  readonly 'Node Type'?: string | undefined;
  readonly 'Parent Relationship'?: string | undefined;
  readonly 'Subplan Name'?: string | undefined;
  readonly 'Actual Loops'?: number | undefined;
  readonly 'Shared Hit Blocks'?: number | undefined;
  readonly 'Shared Read Blocks'?: number | undefined;
  readonly 'Temp Read Blocks'?: number | undefined;
  readonly 'Temp Written Blocks'?: number | undefined;
  readonly Plans?: readonly PlanNode[] | undefined;
  readonly [key: string]: unknown;
};

type SampleContext = {
  readonly round: number;
  readonly order: 'AB' | 'BA';
  readonly variant: 'legacy' | 'initplan';
  readonly query: string;
};

type Sample = SampleContext & {
  readonly executionMs: number;
  readonly planningMs: number;
  readonly sharedHitBlocks: number;
  readonly sharedReadBlocks: number;
  readonly tempReadBlocks: number;
  readonly tempWrittenBlocks: number;
  readonly initPlans: readonly {
    readonly name: string;
    readonly loops: number | null;
  }[];
  readonly resultRows: number;
  readonly resultDigest: string;
  readonly plan: unknown;
};

type PolicyChange = {
  readonly policy: string;
  readonly legacyQual: string | null;
  readonly initplanQual: string | null;
};

type PolicyAudit = {
  readonly before: readonly Policy[];
  readonly after: readonly Policy[];
  readonly changedQuals: readonly PolicyChange[];
};

const planNodeSchema: z.ZodType<PlanNode> = z.lazy(() =>
  z
    .object({
      'Node Type': z.string().optional(),
      'Parent Relationship': z.string().optional(),
      'Subplan Name': z.string().optional(),
      'Actual Loops': z.number().optional(),
      'Shared Hit Blocks': z.number().optional(),
      'Shared Read Blocks': z.number().optional(),
      'Temp Read Blocks': z.number().optional(),
      'Temp Written Blocks': z.number().optional(),
      Plans: z.array(planNodeSchema).optional(),
    })
    .passthrough(),
);

const explainSchema = z
  .object({
    'Planning Time': z.number(),
    'Execution Time': z.number(),
    Plan: planNodeSchema,
  })
  .passthrough();
type Explain = z.infer<typeof explainSchema>;

const schema = 'public';
const appRole = 'fs_billing_app';
const tenantId = '00000000-0000-4000-8000-000000000001';
const rounds = 6;
const legacyPolicies = [
  ['tenants', 'id'],
  ['portal_accounts', 'tenant_id'],
  ['rate_versions', 'tenant_id'],
  ['rate_entries', 'tenant_id'],
  ['ledger_entries', 'tenant_id'],
  ['receivable_settlements', 'tenant_id'],
  ['tenant_balances', 'tenant_id'],
  ['cdrs', 'tenant_id'],
  ['monthly_statements', 'tenant_id'],
  ['balance_alert_settings', 'tenant_id'],
  ['balance_alert_deliveries', 'tenant_id'],
  ['receivable_settlement_reversals', 'tenant_id'],
  ['receivable_voids', 'tenant_id'],
] as const;

const cases: readonly QueryCase[] = [
  {
    name: 'summary',
    sql: `select count(*)::int as calls, sum(billed_minutes)::text as minutes, sum(charge)::text as charge from cdrs where tenant_id = '${tenantId}' and answered_at >= '2026-09-01T00:00:00+08:00'::timestamptz and answered_at < '2026-10-01T00:00:00+08:00'::timestamptz and started_at >= '2026-08-31T00:00:00+08:00'::timestamptz and started_at < '2026-10-01T00:00:00+08:00'::timestamptz`,
    nonEmpty: (rows) => rows.length === 1 && Number(rows[0]?.calls) > 0,
  },
  {
    name: 'deep-page',
    sql: `select call_uuid, started_at, answered_at, ended_at, caller, callee, country, duration_seconds, billed_minutes, rate, charge, hangup_cause from cdrs where tenant_id = '${tenantId}' and answered_at >= '2026-09-01T00:00:00+08:00'::timestamptz and answered_at < '2026-10-01T00:00:00+08:00'::timestamptz and started_at >= '2026-08-31T00:00:00+08:00'::timestamptz and started_at < '2026-10-01T00:00:00+08:00'::timestamptz order by answered_at desc, call_uuid desc limit 50 offset 117150`,
    nonEmpty: (rows) => rows.length > 0,
  },
  {
    name: 'search',
    sql: `select call_uuid, started_at, answered_at, ended_at, caller, callee, country, duration_seconds, billed_minutes, rate, charge, hangup_cause from cdrs where tenant_id = '${tenantId}' and answered_at >= '2026-09-01T00:00:00+08:00'::timestamptz and answered_at < '2026-10-01T00:00:00+08:00'::timestamptz and started_at >= '2026-08-31T00:00:00+08:00'::timestamptz and started_at < '2026-10-01T00:00:00+08:00'::timestamptz and billing_number like '%100000%' order by answered_at desc, call_uuid desc limit 50`,
    nonEmpty: (rows) => rows.length > 0,
  },
];

function requireLoopbackPerfUrl(raw: string | undefined): string {
  if (!raw) throw new Error('PERF_DATABASE_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PERF_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const ipVersion = isIP(host);
  const loopback =
    host === 'localhost' ||
    (ipVersion === 4 && host.startsWith('127.')) ||
    host === '::1';
  if (!loopback || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error(
      'PERF_DATABASE_URL must use PostgreSQL and resolve to localhost, 127.0.0.0/8, or ::1',
    );
  }
  if (decodeURIComponent(url.pathname.slice(1)) !== 'fs_billing_perf') {
    throw new Error(
      'PERF_DATABASE_URL must name the local fs_billing_perf database',
    );
  }
  return raw;
}

function normalizePolicies(rows: readonly Policy[]): Policy[] {
  return rows
    .map((row) => ({ ...row, roles: [...row.roles].sort() }))
    .sort((a, b) =>
      `${a.schemaname}.${a.tablename}.${a.policyname}`.localeCompare(
        `${b.schemaname}.${b.tablename}.${b.policyname}`,
      ),
    );
}

async function policySnapshot(client: pg.Client): Promise<Policy[]> {
  const result = await client.query(
    `SELECT schemaname, tablename, policyname, permissive,
            array_to_json(roles) AS roles, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname = $1
      ORDER BY tablename, policyname`,
    [schema],
  );
  return normalizePolicies(policySchema.array().parse(result.rows));
}

async function restoreLegacyPolicies(client: pg.Client): Promise<void> {
  for (const [table, tenantColumn] of legacyPolicies) {
    await client.query(
      `ALTER POLICY tenant_read ON ${schema}.${table} USING (app_can_see(${tenantColumn}))`,
    );
  }
}

function assertMigrationOnlyChangesQual(
  before: readonly Policy[],
  after: readonly Policy[],
): PolicyChange[] {
  const beforeByKey = new Map(
    before.map((policy) => [
      `${policy.schemaname}.${policy.tablename}.${policy.policyname}`,
      policy,
    ]),
  );
  const afterByKey = new Map(
    after.map((policy) => [
      `${policy.schemaname}.${policy.tablename}.${policy.policyname}`,
      policy,
    ]),
  );
  if (beforeByKey.size !== afterByKey.size)
    throw new Error('Migration changed the number of public policies');
  const changed: PolicyChange[] = [];
  for (const [key, oldPolicy] of beforeByKey) {
    const next = afterByKey.get(key);
    if (!next) throw new Error(`Policy disappeared: ${key}`);
    if (oldPolicy.qual !== next.qual) {
      if (
        oldPolicy.schemaname !== schema ||
        oldPolicy.policyname !== 'tenant_read' ||
        !legacyPolicies.some(([table]) => table === oldPolicy.tablename)
      ) {
        throw new Error(`Unexpected policy predicate change: ${key}`);
      }
      changed.push({
        policy: key,
        legacyQual: oldPolicy.qual,
        initplanQual: next.qual,
      });
    }
    if (
      oldPolicy.schemaname !== next.schemaname ||
      oldPolicy.tablename !== next.tablename ||
      oldPolicy.policyname !== next.policyname ||
      oldPolicy.permissive !== next.permissive ||
      JSON.stringify(oldPolicy.roles) !== JSON.stringify(next.roles) ||
      oldPolicy.cmd !== next.cmd ||
      oldPolicy.with_check !== next.with_check
    ) {
      throw new Error(`Migration changed policy metadata beyond qual: ${key}`);
    }
  }
  const expected = legacyPolicies
    .map(([table]) => `${schema}.${table}.tenant_read`)
    .sort();
  const changedNames = changed.map((policy) => policy.policy).sort();
  if (JSON.stringify(changedNames) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected exactly 13 tenant_read qual changes; got ${changed.length}`,
    );
  }
  for (const [table, tenantColumn] of legacyPolicies) {
    const row = afterByKey.get(`${schema}.${table}.tenant_read`);
    const col = tenantColumn === 'id' ? 'id' : 'tenant_id';
    if (
      !row?.qual?.includes('app_is_operator') ||
      !row.qual.includes('app_scope') ||
      !row.qual.includes(col)
    ) {
      throw new Error(`InitPlan predicate missing expected terms for ${table}`);
    }
  }
  return changed;
}

async function assertAppRole(client: pg.Client): Promise<void> {
  const result = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [
    appRole,
  ]);
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls) {
    throw new Error(
      'fs_billing_app must exist and have neither SUPERUSER nor BYPASSRLS',
    );
  }
}

async function setTenantAppRole(client: pg.Client): Promise<void> {
  await client.query(`SET LOCAL ROLE ${appRole}`);
  await client.query(
    "SELECT set_config('app.scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
    [tenantId],
  );
  const result = await client.query<{
    current_user: string;
    scope: string;
    tenant_id: string;
  }>(
    "SELECT current_user, current_setting('app.scope') AS scope, current_setting('app.tenant_id') AS tenant_id",
  );
  const row = result.rows[0];
  if (
    row?.current_user !== appRole ||
    row.scope !== 'tenant' ||
    row.tenant_id !== tenantId
  ) {
    throw new Error(
      'Benchmark query role or tenant scope was not set as expected',
    );
  }
}

function collectInitPlans(
  node: PlanNode,
  found: { name: string; loops: number | null }[] = [],
): typeof found {
  if (
    node['Parent Relationship'] === 'InitPlan' ||
    node['Subplan Name']?.startsWith('InitPlan')
  ) {
    found.push({
      name: node['Subplan Name'] ?? node['Node Type'] ?? 'InitPlan',
      loops: node['Actual Loops'] ?? null,
    });
  }
  for (const child of node.Plans ?? []) collectInitPlans(child, found);
  return found;
}

function parseExplain(value: unknown): Explain {
  return explainSchema.parse(value);
}

async function runQuery(
  client: pg.Client,
  queryCase: QueryCase,
  variant: Sample['variant'],
  context?: Pick<Sample, 'round' | 'order'>,
  samples?: Sample[],
): Promise<string> {
  const explained = await client.query<{ 'QUERY PLAN': unknown }>(
    `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, SUMMARY ON, FORMAT JSON) ${queryCase.sql}`,
  );
  const rawPlan = explained.rows[0]?.['QUERY PLAN'];
  const parsed: unknown =
    typeof rawPlan === 'string' ? JSON.parse(rawPlan) : rawPlan;
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error(`EXPLAIN returned no plan for ${queryCase.name}`);
  const explain = parseExplain(parsed[0]);
  if (!Number.isFinite(explain['Execution Time']))
    throw new Error(
      `EXPLAIN returned no execution stats for ${queryCase.name}`,
    );
  const initPlans = collectInitPlans(explain.Plan);
  if (
    variant === 'initplan' &&
    (initPlans.length < 3 || initPlans.some((item) => item.loops !== 1))
  ) {
    throw new Error(
      `Expected an InitPlan with exactly one loop for ${queryCase.name}`,
    );
  }
  const actual = await client.query<Record<string, unknown>>(queryCase.sql);
  const rows = z.array(z.record(z.string(), z.unknown())).parse(actual.rows);
  if (!queryCase.nonEmpty(rows))
    throw new Error(`${queryCase.name} returned no qualifying data`);
  const signature = JSON.stringify(rows);
  if (context && samples) {
    samples.push({
      ...context,
      variant,
      query: queryCase.name,
      executionMs: explain['Execution Time'],
      planningMs: explain['Planning Time'],
      sharedHitBlocks: explain.Plan['Shared Hit Blocks'] ?? 0,
      sharedReadBlocks: explain.Plan['Shared Read Blocks'] ?? 0,
      tempReadBlocks: explain.Plan['Temp Read Blocks'] ?? 0,
      tempWrittenBlocks: explain.Plan['Temp Written Blocks'] ?? 0,
      initPlans,
      resultRows: actual.rowCount ?? rows.length,
      resultDigest: createHash('sha256').update(signature).digest('hex'),
      plan: parsed[0],
    });
  }
  return signature;
}

async function begin(client: pg.Client): Promise<void> {
  await client.query('BEGIN');
  await restoreLegacyPolicies(client);
}

async function runWarmup(
  client: pg.Client,
  migrationSql: string,
): Promise<PolicyAudit> {
  await begin(client);
  try {
    const baseline = await policySnapshot(client);
    await setTenantAppRole(client);
    const legacyResults: string[] = [];
    for (const queryCase of cases)
      legacyResults.push(await runQuery(client, queryCase, 'legacy'));
    await client.query('RESET ROLE');
    await client.query(migrationSql);
    const after = await policySnapshot(client);
    const changedQuals = assertMigrationOnlyChangesQual(baseline, after);
    await setTenantAppRole(client);
    for (const [index, queryCase] of cases.entries()) {
      const result = await runQuery(client, queryCase, 'initplan');
      if (result !== legacyResults[index])
        throw new Error(`Warmup results differ for ${queryCase.name}`);
    }
    return { before: baseline, after, changedQuals };
  } finally {
    await client.query('ROLLBACK');
  }
}

async function runPair(
  client: pg.Client,
  migrationSql: string,
  round: number,
  order: 'AB' | 'BA',
  samples: Sample[],
): Promise<void> {
  await begin(client);
  try {
    const before = await policySnapshot(client);
    const signatures = new Map<string, string>();
    const runVariant = async (variant: 'legacy' | 'initplan') => {
      await setTenantAppRole(client);
      for (const queryCase of cases) {
        const signature = await runQuery(
          client,
          queryCase,
          variant,
          { round, order },
          samples,
        );
        const other = signatures.get(
          `${queryCase.name}:${variant === 'legacy' ? 'initplan' : 'legacy'}`,
        );
        if (other && other !== signature)
          throw new Error(
            `A/B result rows differ for ${queryCase.name} in round ${round}`,
          );
        signatures.set(`${queryCase.name}:${variant}`, signature);
      }
      await client.query('RESET ROLE');
    };

    if (order === 'AB') {
      await runVariant('legacy');
      await client.query(migrationSql);
      assertMigrationOnlyChangesQual(before, await policySnapshot(client));
      await runVariant('initplan');
    } else {
      await client.query(migrationSql);
      assertMigrationOnlyChangesQual(before, await policySnapshot(client));
      await runVariant('initplan');
      await restoreLegacyPolicies(client);
      const restored = await policySnapshot(client);
      if (JSON.stringify(restored) !== JSON.stringify(before))
        throw new Error(
          'Legacy policy restoration did not reproduce the baseline',
        );
      await runVariant('legacy');
    }
  } finally {
    await client.query('ROLLBACK');
  }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

async function main(): Promise<void> {
  const connectionString = requireLoopbackPerfUrl(
    process.env.PERF_DATABASE_URL,
  );
  const migrationFile = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../migrations/0015_rls_initplan.sql',
  );
  const migrationSql = await readFile(migrationFile, 'utf8');
  const client = new pg.Client({
    connectionString,
    application_name: 'rls-initplan-perf',
  });
  const samples: Sample[] = [];
  let errors = 0;
  try {
    await client.connect();
    const identity = await client.query<{
      database: string;
      version: string;
      server_address: string | null;
      server_port: number | null;
    }>(
      'SELECT current_database() AS database, version() AS version, inet_server_addr()::text AS server_address, inet_server_port() AS server_port',
    );
    if (identity.rows[0]?.database !== 'fs_billing_perf')
      throw new Error('Connected database is not fs_billing_perf');
    await assertAppRole(client);
    const profileResult = await client.query(
      `SELECT t.code, count(c.call_uuid)::text AS cdrs,
              count(c.call_uuid) FILTER (
                WHERE c.answered_at >= '2026-09-01T00:00:00+08:00'::timestamptz
                  AND c.answered_at < '2026-10-01T00:00:00+08:00'::timestamptz
                  AND c.started_at >= '2026-08-31T00:00:00+08:00'::timestamptz
                  AND c.started_at < '2026-10-01T00:00:00+08:00'::timestamptz
              )::text AS answered_september,
              count(c.call_uuid) FILTER (
                WHERE c.billing_number LIKE '%100000%'
                  AND c.answered_at >= '2026-09-01T00:00:00+08:00'::timestamptz
                  AND c.answered_at < '2026-10-01T00:00:00+08:00'::timestamptz
                  AND c.started_at >= '2026-08-31T00:00:00+08:00'::timestamptz
                  AND c.started_at < '2026-10-01T00:00:00+08:00'::timestamptz
              )::text AS search_matches
         FROM tenants t LEFT JOIN cdrs c ON c.tenant_id = t.id
        WHERE t.id = $1::uuid
        GROUP BY t.code`,
      [tenantId],
    );
    const fixtureRows = z
      .array(
        z.object({
          code: z.string(),
          cdrs: z.string(),
          answered_september: z.string(),
          search_matches: z.string(),
        }),
      )
      .parse(profileResult.rows);
    const fixtureProfile = fixtureRows[0];
    if (
      fixtureProfile?.code !== 'PORTALBIG' ||
      fixtureProfile.cdrs !== '3000000' ||
      Number(fixtureProfile.answered_september) === 0 ||
      Number(fixtureProfile.search_matches) === 0
    ) {
      throw new Error(
        'fs_billing_perf does not contain the expected PORTALBIG fixture',
      );
    }
    const indexResult = await client.query(
      `SELECT tablename, indexname, indexdef FROM pg_indexes
        WHERE schemaname = $1 AND (tablename = 'cdrs' OR tablename LIKE 'cdrs\\_%')
        ORDER BY tablename, indexname`,
      [schema],
    );
    const indexes = z
      .array(
        z.object({
          tablename: z.string(),
          indexname: z.string(),
          indexdef: z.string(),
        }),
      )
      .parse(indexResult.rows);
    if (indexes.length === 0)
      throw new Error(
        'No cdrs indexes found; refusing an unrepresentative run',
      );

    const policyAudit = await runWarmup(client, migrationSql);
    for (let round = 1; round <= rounds; round += 1) {
      await runPair(
        client,
        migrationSql,
        round,
        round % 2 === 1 ? 'AB' : 'BA',
        samples,
      );
    }

    const summary = cases.map((queryCase) => {
      const side = (variant: Sample['variant']) => {
        const values = samples
          .filter(
            (sample) =>
              sample.query === queryCase.name && sample.variant === variant,
          )
          .map((sample) => sample.executionMs);
        if (values.length !== rounds)
          throw new Error(
            `Expected ${rounds} samples for ${queryCase.name}/${variant}`,
          );
        return {
          medianMs: median(values),
          minMs: Math.min(...values),
          maxMs: Math.max(...values),
          runs: values.length,
        };
      };
      return {
        query: queryCase.name,
        legacy: side('legacy'),
        initplan: side('initplan'),
      };
    });
    console.log(
      JSON.stringify(
        {
          status: 'complete',
          errors,
          claim:
            'Compare PostgreSQL execution time for the same PORTALBIG summary, deep-page, and search queries with legacy versus InitPlan RLS policies.',
          environment: {
            capturedAt: new Date().toISOString(),
            perfUrlHost: new URL(connectionString).hostname,
            database: identity.rows[0]?.database,
            postgresVersion: identity.rows[0]?.version,
            serverAddress: identity.rows[0]?.server_address,
            serverPort: identity.rows[0]?.server_port,
            nodeVersion: process.version,
            platform: platform(),
            release: release(),
            cpuModel: cpus()[0]?.model,
            cpuCount: cpus().length,
            totalMemoryBytes: totalmem(),
            loadAverage: loadavg(),
            uptimeSeconds: uptime(),
          },
          setup: {
            tenantId,
            migrationFile,
            policyChangedCount: legacyPolicies.length,
            fixtureProfile,
            queryIndexes: indexes,
            pgPolicies: policyAudit,
            queries: cases.map(({ name, sql }) => ({ name, sql })),
            warmupRunsPerVariant: 1,
            reportedPairs: rounds,
          },
          summary,
          rawSamples: samples,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    errors += 1;
    const message =
      error instanceof Error ? error.message : 'Unknown benchmark error';
    console.error(JSON.stringify({ status: 'failed', errors, message }));
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

await main();
