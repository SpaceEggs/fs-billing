import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpus, loadavg, platform, release, totalmem, uptime } from 'node:os';
import { resolve } from 'node:path';
import pg from 'pg';
import { z } from 'zod';
import { connect } from '../src/client.js';
import { migrateDatabase } from '../src/migrate.js';
import { seedDatabase } from '../src/seed.js';

const targets = [
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
const pairs = 6;
const workerTimeoutMs = Number(
  process.env.RLS_INITPLAN_WORKER_TIMEOUT_MS ?? 120_000,
);
if (
  !Number.isSafeInteger(workerTimeoutMs) ||
  workerTimeoutMs < 1 ||
  workerTimeoutMs > 120_000
)
  throw new Error(
    'RLS_INITPLAN_WORKER_TIMEOUT_MS must be an integer from 1 to 120000',
  );
const repoRoot = resolve(import.meta.dirname, '../../..');
const resultSchema = z.object({
  entries: z.literal(500),
  requests: z.literal(1000),
  p95Ms: z.number().finite(),
  maxMs: z.number().finite(),
  passed: z.boolean(),
});
const serverIdentitySchema = z.object({
  database: z.string(),
  version: z.string(),
  server_address: z.string().nullable(),
  server_port: z.number().nullable(),
  role: z.string(),
  rolcreatedb: z.boolean(),
  rolsuper: z.boolean(),
});
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
const indexSchema = z.object({
  tablename: z.string(),
  indexname: z.string(),
  indexdef: z.string(),
});
type Policy = z.infer<typeof policySchema>;
type WorkerResult = z.infer<typeof resultSchema>;
type Variant = 'legacy' | 'initplan';
type Sample = {
  readonly round: number;
  readonly order: 'AB' | 'BA';
  readonly variant: Variant;
  readonly database: string;
  readonly worker: WorkerResult;
};
let interruptedBy: NodeJS.Signals | undefined;
let activeWorker: ChildProcess | undefined;
let stopActiveWorker: (() => void) | undefined;

function terminateWorkerGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function assertNotInterrupted() {
  if (interruptedBy) throw new Error(`Interrupted by ${interruptedBy}`);
}

function requiredUrl(
  name: string,
  expectedUser: string,
  expectedDatabase: string,
) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') ||
    decodeURIComponent(url.username) !== expectedUser ||
    decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase
  ) {
    throw new Error(
      `${name} must target loopback ${expectedDatabase} as ${expectedUser}`,
    );
  }
  return url;
}

function databaseUrl(template: URL, database: string): string {
  if (!/^fsb_rls_w_[a-f0-9]{8}_[0-9]{2}_(?:seed|base|new)$/.test(database))
    throw new Error(
      `Refusing unexpected disposable database name: ${database}`,
    );
  const url = new URL(template);
  url.pathname = `/${database}`;
  return url.toString();
}

async function policySnapshot(client: pg.Client): Promise<Policy[]> {
  const result = await client.query(
    `SELECT schemaname, tablename, policyname, permissive,
            array_to_json(roles)::text::json AS roles, cmd, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname`,
  );
  return z.array(policySchema).parse(result.rows);
}

async function indexSnapshot(client: pg.Client) {
  const result = await client.query(
    `SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname`,
  );
  return z.array(indexSchema).parse(result.rows);
}

function assertOnlyTargetQualsChanged(
  legacy: readonly Policy[],
  initplan: readonly Policy[],
) {
  if (legacy.length !== initplan.length)
    throw new Error('The policy row count changed between variants');
  const changed = legacy.flatMap((before, index) => {
    const after = initplan[index];
    if (!after) throw new Error('The policy snapshot is incomplete');
    const sameExceptQual =
      before.schemaname === after.schemaname &&
      before.tablename === after.tablename &&
      before.policyname === after.policyname &&
      before.permissive === after.permissive &&
      JSON.stringify(before.roles) === JSON.stringify(after.roles) &&
      before.cmd === after.cmd &&
      before.with_check === after.with_check;
    if (!sameExceptQual)
      throw new Error(
        `Unexpected policy change: ${before.tablename}.${before.policyname}`,
      );
    return before.qual === after.qual
      ? []
      : [
          {
            table: before.tablename,
            policy: before.policyname,
            before: before.qual,
            after: after.qual,
          },
        ];
  });
  const expected = new Set<string>(targets.map(([table]) => table));
  if (
    changed.length !== targets.length ||
    changed.some(
      (change) =>
        change.policy !== 'tenant_read' || !expected.delete(change.table),
    ) ||
    expected.size !== 0
  ) {
    throw new Error(
      'The baseline must differ from the migrated schema in exactly the 13 tenant_read quals',
    );
  }
  return changed;
}

async function setLegacyPolicies(client: pg.Client) {
  for (const [table, tenantColumn] of targets) {
    await client.query(
      `ALTER POLICY tenant_read ON public.${table} USING (app_can_see(${tenantColumn}))`,
    );
  }
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function summarize(samples: readonly Sample[], variant: Variant) {
  const values = samples
    .filter((sample) => sample.variant === variant)
    .map((sample) => sample.worker.p95Ms);
  if (values.length !== pairs)
    throw new Error(`Expected ${pairs} Worker samples for ${variant}`);
  return {
    runs: values.length,
    medianP95Ms: median(values),
    minP95Ms: Math.min(...values),
    maxP95Ms: Math.max(...values),
  };
}

async function runWorker(
  database: string,
  appUrl: string,
): Promise<WorkerResult> {
  assertNotInterrupted();
  const run = spawn(
    'pnpm',
    ['--filter', '@fs-billing/worker', 'perf:authorize'],
    {
      cwd: repoRoot,
      env: { ...process.env, APP_DATABASE_URL: appUrl },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  activeWorker = run;
  let stdout = '';
  let stderr = '';
  let termination: 'timeout' | NodeJS.Signals | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let timeoutTimer: NodeJS.Timeout | undefined;
  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const terminate = (reason: 'timeout' | NodeJS.Signals) => {
      if (termination) return;
      termination = reason;
      try {
        terminateWorkerGroup(run, 'SIGTERM');
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('Failed to stop Worker process group'),
        );
        return;
      }
      killTimer = setTimeout(() => {
        try {
          terminateWorkerGroup(run, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            reject(
              error instanceof Error
                ? error
                : new Error('Failed to kill Worker process group'),
            );
        }
      }, 1_000);
      killTimer.unref();
    };
    stopActiveWorker = () => {
      if (interruptedBy) terminate(interruptedBy);
    };
    timeoutTimer = setTimeout(() => terminate('timeout'), workerTimeoutMs);
    timeoutTimer.unref();
    run.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString()}`.slice(-8 * 1024 * 1024);
    });
    run.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-8 * 1024 * 1024);
    });
    run.once('error', reject);
    run.once('close', (code, signal) => resolve({ code, signal }));
    if (interruptedBy) stopActiveWorker();
  }).finally(() => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    if (activeWorker === run) activeWorker = undefined;
    stopActiveWorker = undefined;
  });
  if (termination === 'timeout')
    throw new Error(
      `Worker run timed out after ${workerTimeoutMs} ms for ${database}`,
    );
  if (termination)
    throw new Error(`Worker run interrupted by ${termination} for ${database}`);
  const outputLines = stdout.trim().split(/\r?\n/).filter(Boolean);
  const rawResult = outputLines.at(-1);
  if (result.code !== 0 || !rawResult) {
    throw new Error(
      `Worker run failed for ${database}; exit=${result.code}; signal=${result.signal}; stderr=${stderr.trim().slice(-2000)}`,
    );
  }
  const parsed = resultSchema.parse(JSON.parse(rawResult));
  if (!parsed.passed)
    throw new Error(`Worker authorization p95 exceeded 50 ms for ${database}`);
  return parsed;
}

async function main() {
  process.on('SIGINT', () => {
    interruptedBy ??= 'SIGINT';
    stopActiveWorker?.();
  });
  process.on('SIGTERM', () => {
    interruptedBy ??= 'SIGTERM';
    stopActiveWorker?.();
  });
  if (
    !process.env.WORKER_SHARED_KEY ||
    process.env.WORKER_SHARED_KEY.length < 16
  )
    throw new Error('WORKER_SHARED_KEY must contain at least 16 characters');
  if (!process.env.WORKER_ALLOWED_IPS)
    throw new Error('WORKER_ALLOWED_IPS is required');
  const ownerTemplate = requiredUrl('DATABASE_URL', 'fs_billing', 'fs_billing');
  const appTemplate = requiredUrl(
    'APP_DATABASE_URL',
    'fs_billing_app',
    'fs_billing',
  );
  const authRaw = process.env.AUTH_DATABASE_URL;
  const authTemplate = authRaw
    ? requiredUrl('AUTH_DATABASE_URL', 'fs_billing_auth', 'fs_billing')
    : undefined;
  const token = randomUUID().replaceAll('-', '').slice(0, 8);
  const dbName = (round: number, variant: 'seed' | 'base' | 'new') =>
    `fsb_rls_w_${token}_${String(round).padStart(2, '0')}_${variant}`;
  const created = new Set<string>();
  const owner = new pg.Client({
    connectionString: ownerTemplate.toString(),
    application_name: 'rls-initplan-worker-benchmark',
  });
  const samples: Sample[] = [];
  let ownerConnected = false;
  let report: Record<string, unknown> | undefined;
  let primaryFailure: unknown;
  let didPrimaryFail = false;
  let cleanupError: string | undefined;
  try {
    await owner.connect();
    ownerConnected = true;
    const identityResult = await owner.query(
      `SELECT current_database() AS database, version() AS version,
              inet_server_addr()::text AS server_address, inet_server_port() AS server_port,
              current_user AS role, r.rolcreatedb, r.rolsuper
         FROM pg_roles r WHERE r.rolname = current_user`,
    );
    const server = serverIdentitySchema.parse(identityResult.rows[0]);
    if (
      server?.database !== 'fs_billing' ||
      server?.role !== 'fs_billing' ||
      server?.rolcreatedb !== true ||
      server?.rolsuper !== true
    ) {
      throw new Error(
        'Owner connection identity did not match the verified local fs_billing endpoint',
      );
    }
    const seedName = dbName(0, 'seed');
    await owner.query(`CREATE DATABASE ${seedName} TEMPLATE template0`);
    created.add(seedName);
    const env = {
      DATABASE_URL: databaseUrl(ownerTemplate, seedName),
      APP_DATABASE_URL: databaseUrl(appTemplate, seedName),
      ...(authTemplate
        ? { AUTH_DATABASE_URL: databaseUrl(authTemplate, seedName) }
        : {}),
    };
    await migrateDatabase(env);
    const seedConnection = connect(env.DATABASE_URL);
    try {
      await seedDatabase(seedConnection.db);
    } finally {
      await seedConnection.pool.end();
    }

    const templateClient = new pg.Client({
      connectionString: env.DATABASE_URL,
    });
    let templatePolicies: Policy[];
    let templateIndexes: Awaited<ReturnType<typeof indexSnapshot>>;
    try {
      await templateClient.connect();
      templatePolicies = await policySnapshot(templateClient);
      templateIndexes = await indexSnapshot(templateClient);
      const targetQuals = templatePolicies.filter(
        (policy) =>
          policy.policyname === 'tenant_read' &&
          targets.some(([table]) => table === policy.tablename),
      );
      if (
        targetQuals.length !== targets.length ||
        targetQuals.some(
          (policy) => !policy.qual?.includes('( SELECT app_scope()'),
        )
      )
        throw new Error(
          'Seed template did not apply the InitPlan migration to all 13 policies',
        );
    } finally {
      await templateClient.end();
    }

    const benchmarkStartedAt = new Date().toISOString();
    const loadAverageBefore = loadavg();
    const orderSummary: ('AB' | 'BA')[] = [];
    let baselinePolicySnapshot: Policy[] | undefined;
    let changedQualSnapshot:
      ReturnType<typeof assertOnlyTargetQualsChanged> | undefined;
    for (let round = 1; round <= pairs; round += 1) {
      assertNotInterrupted();
      const order = round % 2 === 1 ? 'AB' : 'BA';
      orderSummary.push(order);
      const baseName = dbName(round, 'base');
      const newName = dbName(round, 'new');
      for (const name of [baseName, newName]) {
        await owner.query(`CREATE DATABASE ${name} TEMPLATE ${seedName}`);
        created.add(name);
      }
      const baseUrl = databaseUrl(appTemplate, baseName);
      const newUrl = databaseUrl(appTemplate, newName);
      const baseClient = new pg.Client({
        connectionString: databaseUrl(ownerTemplate, baseName),
      });
      try {
        await baseClient.connect();
        await setLegacyPolicies(baseClient);
      } finally {
        await baseClient.end();
      }
      const baseClientCheck = new pg.Client({
        connectionString: databaseUrl(ownerTemplate, baseName),
      });
      const newClientCheck = new pg.Client({
        connectionString: databaseUrl(ownerTemplate, newName),
      });
      let baselinePolicies: Policy[];
      let candidatePolicies: Policy[];
      let baselineIndexes: Awaited<ReturnType<typeof indexSnapshot>>;
      let candidateIndexes: Awaited<ReturnType<typeof indexSnapshot>>;
      try {
        await Promise.all([
          baseClientCheck.connect(),
          newClientCheck.connect(),
        ]);
        [
          baselinePolicies,
          candidatePolicies,
          baselineIndexes,
          candidateIndexes,
        ] = await Promise.all([
          policySnapshot(baseClientCheck),
          policySnapshot(newClientCheck),
          indexSnapshot(baseClientCheck),
          indexSnapshot(newClientCheck),
        ]);
      } finally {
        await Promise.all([baseClientCheck.end(), newClientCheck.end()]);
      }
      const changedQuals = assertOnlyTargetQualsChanged(
        baselinePolicies,
        candidatePolicies,
      );
      if (baselinePolicySnapshot === undefined) {
        baselinePolicySnapshot = baselinePolicies;
        changedQualSnapshot = changedQuals;
      } else if (
        JSON.stringify(baselinePolicySnapshot) !==
          JSON.stringify(baselinePolicies) ||
        JSON.stringify(changedQualSnapshot) !== JSON.stringify(changedQuals)
      ) {
        throw new Error(
          'Policy snapshots differ across Worker benchmark clones',
        );
      }
      if (
        JSON.stringify(baselineIndexes) !== JSON.stringify(candidateIndexes) ||
        JSON.stringify(candidateIndexes) !== JSON.stringify(templateIndexes)
      ) {
        throw new Error(`Index definitions differ in pair ${round}`);
      }
      if (
        JSON.stringify(candidatePolicies) !== JSON.stringify(templatePolicies)
      )
        throw new Error(
          `Candidate policy snapshot differs from the migrated seed template in pair ${round}`,
        );

      const variants: readonly Variant[] =
        order === 'AB' ? ['legacy', 'initplan'] : ['initplan', 'legacy'];
      for (const variant of variants) {
        const database = variant === 'legacy' ? baseName : newName;
        const workerResult = await runWorker(
          database,
          variant === 'legacy' ? baseUrl : newUrl,
        );
        samples.push({ round, order, variant, database, worker: workerResult });
        await owner.query(`DROP DATABASE ${database} WITH (FORCE)`);
        created.delete(database);
      }
      if (changedQuals.length !== targets.length)
        throw new Error(`Expected 13 changed policy quals in pair ${round}`);
    }

    assertNotInterrupted();
    const summary = {
      legacy: summarize(samples, 'legacy'),
      initplan: summarize(samples, 'initplan'),
    };
    const successfulRequests = samples.reduce(
      (count, sample) => count + sample.worker.requests,
      0,
    );
    if (
      samples.length !== pairs * 2 ||
      successfulRequests !== pairs * 2 * 1000 ||
      samples.some((sample) => !sample.worker.passed)
    ) {
      throw new Error('Not all Worker authorization requests passed');
    }
    report = {
      status: 'complete',
      errors: 0,
      claim:
        'Loopback HTTP authorization p95 from the unchanged Worker perf:authorize script on fresh, identical local database clones.',
      requestValidation:
        'Each 1,000-request child run exits nonzero on any non-200 response or response-body mismatch; all 12 children exited zero.',
      environment: {
        benchmarkStartedAt,
        capturedAt: new Date().toISOString(),
        sourceDatabase: server.database,
        databaseHost: ownerTemplate.hostname,
        postgresVersion: server.version,
        serverAddress: server.server_address,
        serverPort: server.server_port,
        nodeVersion: process.version,
        platform: platform(),
        release: release(),
        cpuModel: cpus()[0]?.model,
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        loadAverageBefore,
        loadAverageAfter: loadavg(),
        uptimeSeconds: uptime(),
      },
      setup: {
        fixtureSource:
          'Project migrations (including 0015) plus seedDatabase on a fresh local disposable database.',
        clonePairPolicyDiff:
          'Baseline clones restore the 13 tenant_read quals to app_can_see; candidate clones retain the actual migrated 0015 policies.',
        identicalIndexes: true,
        indexes: templateIndexes,
        pgPolicies: {
          before: baselinePolicySnapshot,
          after: templatePolicies,
          changedQuals: changedQualSnapshot,
        },
        orders: orderSummary,
        requestsPerSample: 1000,
        successfulRequests,
        failedRequests: 0,
        responseAssertionsPerRequest:
          'HTTP status 200 plus exact allowed/maxSeconds/billingNumber JSON.',
        rateEntriesPerSample: 500,
        disposableDatabasePrefix: `fsb_rls_w_${token}_`,
      },
      summary,
      rawSamples: samples,
    };
  } catch (error) {
    didPrimaryFail = true;
    primaryFailure = error;
  } finally {
    if (ownerConnected) {
      for (const database of created) {
        try {
          await owner.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        } catch {
          cleanupError ??= 'failed to drop one or more disposable databases';
        }
      }
      try {
        const leftovers = await owner.query<{ datname: string }>(
          'SELECT datname FROM pg_database WHERE starts_with(datname, $1)',
          [`fsb_rls_w_${token}_`],
        );
        if (leftovers.rows.length > 0)
          cleanupError = `disposable databases remain: ${leftovers.rows
            .map((row) => row.datname)
            .join(', ')}`;
      } catch {
        cleanupError ??= 'failed to verify disposable database cleanup';
      }
    }
    await owner.end().catch(() => {
      cleanupError ??= 'failed to close the local database connection';
    });
  }
  if (cleanupError) {
    if (didPrimaryFail) {
      const primaryMessage =
        primaryFailure instanceof Error
          ? primaryFailure.message
          : String(primaryFailure);
      throw new Error(`${primaryMessage}; cleanup failed: ${cleanupError}`, {
        cause: primaryFailure,
      });
    }
    throw new Error(`Cleanup failed: ${cleanupError}`);
  }
  if (didPrimaryFail) throw primaryFailure;
  assertNotInterrupted();
  if (!report) throw new Error('Worker benchmark did not produce a result');
  console.log(
    JSON.stringify({ ...report, cleanup: 'verified-empty' }, null, 2),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: 'failed', message }));
  process.exitCode = 1;
}
