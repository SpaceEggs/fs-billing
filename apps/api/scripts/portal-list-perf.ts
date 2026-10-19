import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import {
  adminCdrsResponseSchema,
  portalCdrsResponseSchema,
} from '@fs-billing/shared';

export const PERF_DATABASE = z
  .enum(['fs_billing_perf', 'fs_billing_perf_pr3_uuid_v4'])
  .parse(process.env.PERF_TARGET_DATABASE ?? 'fs_billing_perf');
const PR3_PERF_DATABASE = 'fs_billing_perf_pr3_uuid_v4';
const TENANT_CODE = process.env.PERF_TENANT_CODE ?? 'PORTALBIG';
const FROM = process.env.PERF_FROM ?? '2026-09-01';
const TO = process.env.PERF_TO ?? '2026-09-30';
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 7);
const PREFLIGHT = process.env.PERF_PREFLIGHT === '1';
const PAGE_SIZE = 50;
const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

export type Audience = 'portal' | 'admin';
export type Identity = {
  kind: Audience;
  profileId: string;
  userId: string;
  email: string;
  sessionId: string;
  token: string;
  cookie: string;
};
export type CreatedRows = {
  userIds: string[];
  portalAccountIds: string[];
  adminIds: string[];
  sessionIds: string[];
  auditIds: string[];
};
export type RssSample = {
  elapsedMs: number;
  receivedRows: number;
  rssBytes: number;
};
export type ApiChildExit = {
  gracefulExit: boolean;
  forcedKill: boolean;
  exitCode: number | null;
  signalCode: string | null;
  exitedAfterKill?: boolean;
};
export type ExportCompletedEvent = {
  requestId: string;
  rows: number;
  elapsedMs: number;
  result: string;
};
export class ApiStartupError extends Error {
  constructor(
    readonly startupError: string,
    readonly cleanup: ApiChildExit | null,
    readonly diagnostics: string,
    readonly exportEvents: ExportCompletedEvent[],
    readonly childPid: number | null,
    readonly cleanupError: string | null = null,
  ) {
    super(`API startup failed: ${startupError}`);
    this.name = 'ApiStartupError';
  }
}
type Case = {
  name: string;
  audience: Audience;
  query: Record<string, string>;
  deepPage: boolean;
};
type Sample = {
  scenario: string;
  attempt: 'warmup' | 'deep-page-warmup' | 'measured';
  page: number;
  round: number;
  elapsedMs: number;
  status: number | null;
  outcome: 'complete' | 'http-error' | 'invalid-response' | 'request-error';
  error: string | null;
  bodySummary: {
    bytes: number;
    contentType: string | null;
    apiErrorCode?: string;
  } | null;
  responseBytes: number;
  total: number | null;
  items: number | null;
};

function errorText(error: unknown) {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted-url]')
    .replace(/better-auth\.session_token=[^\s"']+/g, '[redacted-cookie]')
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      '[redacted-email]',
    )
    .slice(0, 1000);
}

function responseSummary(text: string, contentType: string | null) {
  let apiErrorCode: string | undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'object' &&
      body.error !== null &&
      'code' in body.error &&
      typeof body.error.code === 'string'
    )
      apiErrorCode = body.error.code;
  } catch {
    // Preserve only metadata from non-JSON bodies to avoid copying customer data into evidence.
  }
  return {
    bytes: Buffer.byteLength(text),
    contentType,
    ...(apiErrorCode ? { apiErrorCode } : {}),
  };
}

type CdrIndexSpec = { name: string; unique: boolean; columns: string[] };
const migrationJournalSchema = z.object({
  entries: z.array(z.object({ tag: z.string() })),
});

export type DatabaseProfile = {
  id: string;
  database: string;
  role: string;
  serverVersion: string;
  repositoryMigrationJournalSha256: string;
  appliedMigrations: {
    count: number;
    latestHash: string | null;
    latestCreatedAt: string | null;
  };
  cdrIndexes: {
    schemaname: string;
    tablename: string;
    indexname: string;
    indexdef: string;
    level: number;
  }[];
  cdrIndexDefinitionsSha256: string;
};

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

async function migrationCdrIndexes() {
  const migrationsUrl = new URL(
    '../../../packages/db/migrations/',
    import.meta.url,
  );
  const journalBytes = await readFile(
    new URL('meta/_journal.json', migrationsUrl),
  );
  const journal = migrationJournalSchema.parse(
    JSON.parse(journalBytes.toString('utf8')),
  );
  const indexes = new Map<string, CdrIndexSpec>();

  for (const entry of journal.entries) {
    const source = (
      await readFile(new URL(`${entry.tag}.sql`, migrationsUrl), 'utf8')
    ).replace(/--[^\r\n]*/g, '');
    const table =
      /CREATE\s+TABLE\s+cdrs\s*\(([\s\S]*?)\)\s*PARTITION\s+BY\s+RANGE/i.exec(
        source,
      )?.[1];
    const primaryKey = table && /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(table)?.[1];
    if (primaryKey)
      indexes.set('cdrs_pkey', {
        name: 'cdrs_pkey',
        unique: true,
        columns: primaryKey
          .split(',')
          .map((column) => column.trim().replaceAll('"', '')),
      });

    const createIndex =
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[\w"]+\.)?"?([\w]+)"?\s+ON\s+(?:[\w"]+\.)?"?cdrs"?\s*\(([^;]+?)\)\s*;/gi;
    for (const match of source.matchAll(createIndex)) {
      const name = match[2];
      const columns = match[3];
      assert(name && columns, `could not parse CDR index from ${entry.tag}`);
      indexes.set(name, {
        name,
        unique: Boolean(match[1]),
        columns: columns
          .split(',')
          .map((column) => column.trim().replaceAll('"', '')),
      });
    }
    const dropIndex =
      /DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+(?:[\w"]+\.)?"?([\w]+)"?\s*;/gi;
    for (const match of source.matchAll(dropIndex)) {
      const name = match[1];
      if (name) indexes.delete(name);
    }
  }
  assert(indexes.size > 0, 'repository migrations define no CDR indexes');
  return {
    journalBytes,
    indexes: [...indexes.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function inspectDatabaseProfile(
  owner: pg.Client,
  app: pg.Client,
): Promise<DatabaseProfile> {
  const { journalBytes, indexes: expectedIndexes } =
    await migrationCdrIndexes();
  const identity = await app.query<{
    database: string;
    role: string;
    serverVersion: string;
  }>(
    'select current_database() as database, current_user as role, version() as "serverVersion"',
  );
  const actualIdentity = identity.rows[0];
  assert(actualIdentity, 'database identity query returned no row');
  assert.equal(actualIdentity.database, PERF_DATABASE);
  assert.equal(actualIdentity.role, 'fs_billing_app');
  assert.match(actualIdentity.serverVersion, /^PostgreSQL 17\./);

  const applied = await owner.query<{ hash: string; created_at: string }>(
    'select hash, created_at from drizzle.__drizzle_migrations order by id',
  );
  const journal = migrationJournalSchema.parse(
    JSON.parse(journalBytes.toString('utf8')),
  );
  const expectedHashes: string[] = [];
  for (const entry of journal.entries) {
    const contents = await readFile(
      new URL(
        `../../../packages/db/migrations/${entry.tag}.sql`,
        import.meta.url,
      ),
      'utf8',
    );
    expectedHashes.push(sha256(contents));
  }
  assert.deepEqual(
    applied.rows.map((row) => row.hash),
    expectedHashes,
    'database migrations do not match the repository journal SQL files',
  );

  const indexes = await app.query<{
    schemaname: string;
    tablename: string;
    indexname: string;
    indexdef: string;
    level: number;
  }>(
    `select n.nspname as schemaname, t.relname as tablename,
       i.indexname, i.indexdef, p.level
     from pg_partition_tree('public.cdrs'::regclass) p
     join pg_class t on t.oid=p.relid
     join pg_namespace n on n.oid=t.relnamespace
     join pg_indexes i on i.schemaname=n.nspname and i.tablename=t.relname
     order by p.level, t.relname, i.indexname`,
  );
  const currentIndexes = indexes.rows;
  const parentIndexes = currentIndexes.filter(
    (index) => index.tablename === 'cdrs',
  );
  assert.deepEqual(
    parentIndexes.map(({ indexname }) => indexname),
    expectedIndexes.map(({ name }) => name),
    'parent CDR indexes differ from indexes defined by the applied repository migrations',
  );
  for (const expected of expectedIndexes) {
    const actual = parentIndexes.find(
      (index) => index.indexname === expected.name,
    );
    assert(actual, `missing migrated CDR index ${expected.name}`);
    const actualColumns = /USING\s+\w+\s*\(([^()]*)\)\s*$/i.exec(
      actual.indexdef,
    )?.[1];
    assert(
      actualColumns,
      `could not parse CDR index definition ${expected.name}`,
    );
    assert.deepEqual(
      actualColumns
        .split(',')
        .map((column) => column.trim().replaceAll('"', '')),
      expected.columns,
      `CDR index columns differ from migration for ${expected.name}`,
    );
    assert.equal(
      /CREATE\s+UNIQUE\s+INDEX/i.test(actual.indexdef),
      expected.unique,
      `CDR index uniqueness differs from migration for ${expected.name}`,
    );
  }
  const indexSignatures = (rows: typeof currentIndexes) =>
    rows
      .map((index) => {
        const columns = /USING\s+\w+\s*\(([^()]*)\)\s*$/i.exec(
          index.indexdef,
        )?.[1];
        assert(
          columns,
          `could not parse partition CDR index ${index.tablename}.${index.indexname}`,
        );
        return {
          unique: /CREATE\s+UNIQUE\s+INDEX/i.test(index.indexdef),
          columns: columns
            .split(',')
            .map((column) => column.trim().replaceAll('"', '')),
        };
      })
      .sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      );
  const expectedSignatures = expectedIndexes
    .map(({ unique, columns }) => ({ unique, columns }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  const tableNames = [
    ...new Set(currentIndexes.map((index) => index.tablename)),
  ];
  assert(tableNames.includes('cdrs'), 'CDR parent index profile is missing');
  for (const tableName of tableNames.filter((name) => name !== 'cdrs'))
    assert.deepEqual(
      indexSignatures(
        currentIndexes.filter((index) => index.tablename === tableName),
      ),
      expectedSignatures,
      `partition ${tableName} does not have exactly the migration-defined CDR indexes`,
    );

  const journalHash = sha256(journalBytes);
  const indexHash = sha256(JSON.stringify(currentIndexes));
  return {
    id: `${actualIdentity.database}:${actualIdentity.role}:server-${sha256(actualIdentity.serverVersion).slice(0, 8)}:journal-${journalHash.slice(0, 12)}:cdr-indexes-${indexHash.slice(0, 12)}`,
    database: actualIdentity.database,
    role: actualIdentity.role,
    serverVersion: actualIdentity.serverVersion,
    repositoryMigrationJournalSha256: journalHash,
    appliedMigrations: {
      count: applied.rows.length,
      latestHash: applied.rows.at(-1)?.hash ?? null,
      latestCreatedAt: applied.rows.at(-1)
        ? new Date(Number(applied.rows.at(-1)?.created_at)).toISOString()
        : null,
    },
    cdrIndexes: currentIndexes,
    cdrIndexDefinitionsSha256: indexHash,
  };
}

export function databaseUrl(value: string | undefined, role: string | null) {
  assert(value, 'missing local database URL');
  const url = new URL(value);
  assert(localHosts.has(url.hostname), 'performance database must be local');
  assert.equal(
    url.pathname,
    '/fs_billing',
    'expected local development URL template',
  );
  if (role) assert.equal(decodeURIComponent(url.username), role);
  url.pathname = `/${PERF_DATABASE}`;
  return url.toString();
}

export function perfUrls() {
  return {
    owner: databaseUrl(process.env.DATABASE_URL, 'fs_billing'),
    app: databaseUrl(process.env.APP_DATABASE_URL, 'fs_billing_app'),
    auth: databaseUrl(process.env.AUTH_DATABASE_URL, 'fs_billing_auth'),
  };
}

export function cookieFor(token: string, secret: string) {
  const signature = createHmac('sha256', secret).update(token).digest('base64');
  return `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
}

export async function insertIdentity(
  owner: pg.Client,
  auth: pg.Client,
  tenantId: string,
  kind: Audience,
  runId: string,
  secret: string,
  created: CreatedRows,
): Promise<Identity> {
  const identityKey = `${kind}-${runId}-${tenantId}`;
  const userId = `pr3-perf-${identityKey}`;
  const email = `pr3-perf-${identityKey}@example.invalid`;
  const profileId = randomUUID();
  const sessionId = `pr3-perf-session-${identityKey}`;
  const token = randomBytes(32).toString('base64url');
  const name = `PR3 performance fixture ${kind} ${runId}`;

  if (kind === 'portal') {
    const existing = await owner.query(
      'select id from portal_accounts where tenant_id=$1::uuid',
      [tenantId],
    );
    assert.equal(
      existing.rowCount,
      0,
      'tenant already has a portal account; refusing to alter fixture identity',
    );
  }

  const user = await owner.query<{ id: string }>(
    `insert into auth."user"(id, name, email, email_verified)
     values ($1, $2, $3, false) returning id`,
    [userId, name, email],
  );
  assert.equal(user.rows[0]?.id, userId);
  created.userIds.push(userId);

  if (kind === 'portal') {
    const profile = await owner.query<{ id: string }>(
      `insert into portal_accounts(id, auth_user_id, tenant_id, status)
       values ($1::uuid, $2, $3::uuid, 'active') returning id::text`,
      [profileId, userId, tenantId],
    );
    assert.equal(profile.rows[0]?.id, profileId);
    created.portalAccountIds.push(profileId);
  } else {
    const profile = await owner.query<{ id: string }>(
      `insert into admins(id, auth_user_id, name, status)
       values ($1::uuid, $2, $3, 'active') returning id::text`,
      [profileId, userId, name],
    );
    assert.equal(profile.rows[0]?.id, profileId);
    created.adminIds.push(profileId);
  }

  const session = await auth.query<{ id: string }>(
    `insert into auth.session(id, token, user_id, expires_at, created_at, updated_at)
     values ($1, $2, $3, clock_timestamp() + interval '1 hour', clock_timestamp(), clock_timestamp())
     returning id`,
    [sessionId, token, userId],
  );
  assert.equal(session.rows[0]?.id, sessionId);
  created.sessionIds.push(sessionId);
  return {
    kind,
    profileId,
    userId,
    email,
    sessionId,
    token,
    cookie: cookieFor(token, secret),
  };
}

export async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export async function startApi(port: number) {
  const origin = `http://127.0.0.1:${port}`;
  const urls = perfUrls();
  let stdoutTail = '';
  let stderrTail = '';
  let stdoutPending = '';
  const exportEvents: ExportCompletedEvent[] = [];
  const gcOnSignal = process.env.PERF_GC_ON_SIGUSR2 === '1';
  const gcHook = process.env.PERF_GC_HOOK;
  if (gcOnSignal)
    assert(gcHook, 'PERF_GC_HOOK is required with PERF_GC_ON_SIGUSR2');
  const child = spawn(
    process.execPath,
    [
      ...(gcOnSignal ? ['--expose-gc', '--require', gcHook ?? ''] : []),
      '--env-file-if-exists=../../.env',
      '--import',
      'tsx',
      'src/main.ts',
    ],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        DATABASE_URL: urls.owner,
        APP_DATABASE_URL: urls.app,
        AUTH_DATABASE_URL: urls.auth,
        NODE_ENV: 'test',
        API_HOST: '127.0.0.1',
        API_PORT: String(port),
        BETTER_AUTH_URL: origin,
        BETTER_AUTH_TRUSTED_ORIGINS: origin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const collectTail = (current: string, chunk: Buffer) =>
    `${current}${chunk.toString('utf8')}`.slice(-16_000);
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutTail = collectTail(stdoutTail, chunk);
    stdoutPending += chunk.toString('utf8');
    const lines = stdoutPending.split('\n');
    stdoutPending = lines.pop() ?? '';
    for (const line of lines) {
      try {
        const entry: unknown = JSON.parse(line);
        if (
          typeof entry === 'object' &&
          entry !== null &&
          'event' in entry &&
          entry.event === 'export.csv.completed' &&
          'requestId' in entry &&
          typeof entry.requestId === 'string' &&
          'rows' in entry &&
          typeof entry.rows === 'number' &&
          'elapsedMs' in entry &&
          typeof entry.elapsedMs === 'number' &&
          'result' in entry &&
          typeof entry.result === 'string'
        ) {
          exportEvents.push({
            requestId: entry.requestId,
            rows: entry.rows,
            elapsedMs: entry.elapsedMs,
            result: entry.result,
          });
          if (exportEvents.length > 1000) exportEvents.shift();
        }
      } catch {
        // API stdout also contains non-JSON startup lines.
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = collectTail(stderrTail, chunk);
  });
  const diagnostics = () => {
    const secret = process.env.BETTER_AUTH_SECRET;
    return `${stdoutTail}\n${stderrTail}`
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[redacted-url]')
      .replace(/better-auth\.session_token=[^\s"']+/g, '[redacted-cookie]')
      .replace(secret ?? '\u0000', '[redacted-secret]');
  };
  try {
    await waitForApi(child, origin);
  } catch (error) {
    let cleanup: ApiChildExit | null = null;
    let cleanupError: string | null = null;
    try {
      cleanup = await removeApi(child);
    } catch (failure) {
      cleanupError = errorText(failure);
    }
    if (
      cleanup &&
      (!cleanup.gracefulExit ||
        cleanup.forcedKill ||
        (cleanup.exitCode !== null && cleanup.exitCode !== 0) ||
        ('exitedAfterKill' in cleanup && !cleanup.exitedAfterKill))
    )
      cleanupError ??= 'API child did not exit cleanly';
    throw new ApiStartupError(
      errorText(error),
      cleanup,
      diagnostics(),
      exportEvents,
      child.pid ?? null,
      cleanupError,
    );
  }
  return {
    child,
    origin,
    diagnostics,
    exportEvents: () => [...exportEvents],
  };
}

async function waitForApi(child: ChildProcess, origin: string) {
  const deadline = Date.now() + 30_000;
  let lastStatus = 'not ready';
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`API child exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) return;
      lastStatus = `health status ${response.status}`;
    } catch {
      lastStatus = 'health request failed';
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API child readiness timed out: ${lastStatus}`);
}

export function startRssSampler(
  pid: number,
  getRows: () => number,
  intervalMs = 250,
) {
  assert(Number.isInteger(intervalMs) && intervalMs > 0);
  const started = performance.now();
  const samples: RssSample[] = [];
  const sample = () => {
    try {
      const raw = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      const kib = Number(raw);
      if (Number.isFinite(kib) && kib > 0)
        samples.push({
          elapsedMs: Math.round(performance.now() - started),
          receivedRows: getRows(),
          rssBytes: kib * 1024,
        });
    } catch {
      // The child may exit between polling its process table entry.
    }
  };
  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    samples,
    stop: () => {
      clearInterval(timer);
      sample();
    },
  };
}

function median(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  assert(ordered.length > 0);
  const middle = Math.floor(ordered.length / 2);
  const value =
    ordered.length % 2
      ? (ordered[middle] ?? 0)
      : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
  return Number(value.toFixed(1));
}

async function requestList(
  origin: string,
  identity: Identity,
  tenantId: string,
  scenario: Case,
  page: number,
  attempt: Sample['attempt'],
  round: number,
) {
  const query = new URLSearchParams({
    from: FROM,
    to: TO,
    page: String(page),
    ...scenario.query,
  });
  const queryString = query.toString();
  const path =
    scenario.audience === 'portal'
      ? `/api/portal/cdrs?${queryString}`
      : `/api/admin/tenants/${tenantId}/cdrs?${queryString}`;
  const started = performance.now();
  let status: number | null = null;
  let responseBytes = 0;
  let contentType: string | null = null;
  let total: number | null = null;
  let items: number | null = null;
  let outcome: Sample['outcome'] = 'complete';
  let error: string | null = null;
  let bodySummary: Sample['bodySummary'] = null;
  let responseText: string | undefined;
  try {
    const response = await fetch(`${origin}${path}`, {
      headers: { cookie: identity.cookie },
      signal: AbortSignal.timeout(120_000),
    });
    status = response.status;
    contentType = response.headers.get('content-type');
    responseText = await response.text();
    responseBytes = Buffer.byteLength(responseText);
    if (!response.ok) {
      outcome = 'http-error';
      error = `HTTP ${response.status}`;
      bodySummary = responseSummary(responseText, contentType);
    } else {
      const raw: unknown = JSON.parse(responseText);
      const body =
        scenario.audience === 'portal'
          ? portalCdrsResponseSchema.parse(raw)
          : adminCdrsResponseSchema.parse(raw);
      total = body.pagination.total;
      items = body.items.length;
    }
  } catch (caught) {
    outcome = status === null ? 'request-error' : 'invalid-response';
    error = errorText(caught);
    if (responseText !== undefined)
      bodySummary = responseSummary(responseText, contentType);
  }
  return {
    scenario: scenario.name,
    attempt,
    page,
    round,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
    status,
    outcome,
    error,
    bodySummary,
    responseBytes,
    total,
    items,
  };
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timerRef: { current?: ReturnType<typeof setTimeout> } = {};
    const finish = (exited: boolean) => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    timerRef.current = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

export async function removeApi(
  child: ChildProcess | undefined,
): Promise<ApiChildExit> {
  if (!child)
    return {
      gracefulExit: true,
      forcedKill: false,
      exitCode: null,
      signalCode: null,
    };
  if (child.exitCode !== null || child.signalCode !== null)
    return {
      gracefulExit: child.exitCode === 0 || child.signalCode === 'SIGTERM',
      forcedKill: child.signalCode === 'SIGKILL',
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  child.kill('SIGTERM');
  const gracefulExit = await waitForChildExit(child, 5000);
  if (gracefulExit)
    return {
      gracefulExit: true,
      forcedKill: false,
      exitCode: child.exitCode,
      signalCode: child.signalCode,
    };
  child.kill('SIGKILL');
  const exitedAfterKill = await waitForChildExit(child, 2000);
  return {
    gracefulExit: false,
    forcedKill: true,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    exitedAfterKill,
  };
}

function assertCompleteSample(
  sample: Sample,
): asserts sample is Sample & { total: number; items: number } {
  assert.equal(
    sample.outcome,
    'complete',
    `${sample.scenario} ${sample.attempt} page ${sample.page} round ${sample.round}: ${sample.error ?? sample.status}; body=${JSON.stringify(sample.bodySummary)}`,
  );
  assert.equal(
    typeof sample.total,
    'number',
    `${sample.scenario} response missing total`,
  );
  assert.equal(
    typeof sample.items,
    'number',
    `${sample.scenario} response missing items`,
  );
}

async function main() {
  const evidenceDirectory = resolve(
    process.cwd(),
    '../../docs/evidence/phase-6',
  );
  assert(Number.isInteger(ROUNDS), 'PERF_ROUNDS must be an integer');
  if (PREFLIGHT)
    assert.equal(
      ROUNDS,
      1,
      'diagnostic preflight requires exactly one measured round',
    );
  else assert(ROUNDS >= 5, 'formal PERF_ROUNDS must be at least 5');
  if (!PREFLIGHT)
    assert.equal(
      PERF_DATABASE,
      PR3_PERF_DATABASE,
      'formal list acceptance must target fs_billing_perf_pr3_uuid_v4',
    );
  const urls = perfUrls();
  const owner = new pg.Client({
    connectionString: urls.owner,
    connectionTimeoutMillis: 2000,
  });
  const auth = new pg.Client({
    connectionString: urls.auth,
    connectionTimeoutMillis: 2000,
  });
  const appClient = new pg.Client({
    connectionString: urls.app,
    connectionTimeoutMillis: 2000,
  });
  const runId = randomUUID();
  const created: CreatedRows = {
    userIds: [],
    portalAccountIds: [],
    adminIds: [],
    sessionIds: [],
    auditIds: [],
  };
  const identities: Partial<Record<Audience, Identity>> = {};
  const samples: Sample[] = [];
  const rssSamples: RssSample[] = [];
  let child: ChildProcess | undefined;
  let apiOrigin: string | undefined;
  let tenantId: string | undefined;
  let ownerConnected = false;
  let authConnected = false;
  let failure: string | undefined;
  let apiChildLogs = '';
  let readApiLogs: () => string = () => '';
  let apiStartupCleanup: ApiChildExit | null | undefined;
  let apiStartupCleanupError: string | null | undefined;
  let apiStartupChildPid: number | null | undefined;
  const cleanup: Record<string, unknown> = {};
  const cleanupErrors: string[] = [];
  let databaseProfile: DatabaseProfile | undefined;
  let fixtureFacts:
    | { tenantCdrRows: number; answeredRangeRows: number; allRangeRows: number }
    | undefined;
  let appConnected = false;
  try {
    await owner.connect();
    ownerConnected = true;
    await auth.connect();
    authConnected = true;
    await appClient.connect();
    appConnected = true;
    databaseProfile = await inspectDatabaseProfile(owner, appClient);
    const tenant = await owner.query<{ id: string }>(
      'select id::text from tenants where code=$1',
      [TENANT_CODE],
    );
    assert.equal(
      tenant.rowCount,
      1,
      `expected one ${TENANT_CODE} synthetic fixture`,
    );
    tenantId = tenant.rows[0]?.id;
    assert(tenantId);
    const fixture = await owner.query<{
      tenant_rows: string;
      answered_rows: string;
      all_rows: string;
    }>(
      `with bounds as (
         select ($2::date)::timestamp at time zone 'Asia/Shanghai' as lo,
           (($3::date + 1))::timestamp at time zone 'Asia/Shanghai' as hi
       )
       select count(*)::text as tenant_rows,
         count(*) filter (where c.answered_at >= (select lo from bounds)
           and c.answered_at < (select hi from bounds)
           and c.started_at >= (select lo from bounds) - interval '31 days'
           and c.started_at < (select hi from bounds))::text as answered_rows,
         count(*) filter (where coalesce(c.answered_at, c.started_at) >= (select lo from bounds)
           and coalesce(c.answered_at, c.started_at) < (select hi from bounds)
           and c.started_at >= (select lo from bounds) - interval '31 days'
           and c.started_at < (select hi from bounds))::text as all_rows
       from cdrs c where c.tenant_id = $1::uuid`,
      [tenantId, FROM, TO],
    );
    const fixtureRow = fixture.rows[0];
    assert(fixtureRow, 'CDR fixture facts query returned no row');
    fixtureFacts = {
      tenantCdrRows: Number(fixtureRow.tenant_rows),
      answeredRangeRows: Number(fixtureRow.answered_rows),
      allRangeRows: Number(fixtureRow.all_rows),
    };
    if (!PREFLIGHT) {
      assert.equal(
        TENANT_CODE,
        'PORTALBIG',
        'formal list acceptance must use PORTALBIG',
      );
      assert.equal(
        fixtureFacts.tenantCdrRows,
        3_000_000,
        'formal list acceptance requires exactly 3 million PORTALBIG CDR rows',
      );
    }
    const secret = process.env.BETTER_AUTH_SECRET;
    assert(
      secret && Buffer.byteLength(secret) >= 32,
      'BETTER_AUTH_SECRET is unavailable or too short',
    );
    identities.portal = await insertIdentity(
      owner,
      auth,
      tenantId,
      'portal',
      runId,
      secret,
      created,
    );
    identities.admin = await insertIdentity(
      owner,
      auth,
      tenantId,
      'admin',
      runId,
      secret,
      created,
    );

    const port = await freePort();
    const startedApi = await startApi(port);
    child = startedApi.child;
    apiOrigin = startedApi.origin;
    readApiLogs = startedApi.diagnostics;
    const rss = startRssSampler(child.pid ?? 0, () =>
      samples.reduce((sum, sample) => sum + (sample.items ?? 0), 0),
    );

    const cases: Case[] = [
      {
        name: 'portal-answered',
        audience: 'portal',
        query: {},
        deepPage: true,
      },
      {
        name: 'portal-all',
        audience: 'portal',
        query: { status: 'all' },
        deepPage: true,
      },
      {
        name: 'portal-callee',
        audience: 'portal',
        query: { callee: '100000' },
        deepPage: false,
      },
      {
        name: 'portal-country',
        audience: 'portal',
        query: { country: '中国' },
        deepPage: false,
      },
      {
        name: 'portal-callee-country',
        audience: 'portal',
        query: { callee: '100000', country: '中国' },
        deepPage: false,
      },
      { name: 'admin-answered', audience: 'admin', query: {}, deepPage: true },
      {
        name: 'admin-all',
        audience: 'admin',
        query: { status: 'all' },
        deepPage: true,
      },
      {
        name: 'admin-callee',
        audience: 'admin',
        query: { callee: '100000' },
        deepPage: false,
      },
      {
        name: 'admin-country',
        audience: 'admin',
        query: { country: '中国' },
        deepPage: false,
      },
      {
        name: 'admin-callee-country',
        audience: 'admin',
        query: { callee: '100000', country: '中国' },
        deepPage: false,
      },
      {
        name: 'admin-unverified-only',
        audience: 'admin',
        query: { unverifiedOnly: 'true' },
        deepPage: true,
      },
    ];

    for (const scenario of cases) {
      const identity = identities[scenario.audience];
      assert(identity && tenantId && apiOrigin);
      const warmFirst = await requestList(
        apiOrigin,
        identity,
        tenantId,
        scenario,
        1,
        'warmup',
        0,
      );
      samples.push(warmFirst);
      assertCompleteSample(warmFirst);
      if (
        !scenario.query.callee &&
        !scenario.query.country &&
        !scenario.query.unverifiedOnly
      ) {
        const expectedTotal: number =
          scenario.query.status === 'all'
            ? fixtureFacts.allRangeRows
            : fixtureFacts.answeredRangeRows;
        assert.equal(
          warmFirst.total,
          expectedTotal,
          `${scenario.name} month count differs from owner fixture count`,
        );
      }
      const deepPage = scenario.deepPage
        ? Math.max(1, Math.ceil(warmFirst.total / PAGE_SIZE))
        : 1;
      if (scenario.deepPage) {
        const deepWarmup = await requestList(
          apiOrigin,
          identity,
          tenantId,
          scenario,
          deepPage,
          'deep-page-warmup',
          0,
        );
        samples.push(deepWarmup);
        assertCompleteSample(deepWarmup);
      }
      const pages = scenario.deepPage ? [1, deepPage] : [1];
      for (let round = 1; round <= ROUNDS; round += 1) {
        const order = round % 2 ? pages : [...pages].reverse();
        for (const page of order) {
          const result = await requestList(
            apiOrigin,
            identity,
            tenantId,
            scenario,
            page,
            'measured',
            round,
          );
          samples.push(result);
          assertCompleteSample(result);
        }
      }
    }
    rss.stop();
    rssSamples.push(...rss.samples);
  } catch (error) {
    if (error instanceof ApiStartupError) {
      apiStartupCleanup = error.cleanup;
      apiStartupCleanupError = error.cleanupError;
      apiStartupChildPid = error.childPid;
      apiChildLogs = error.diagnostics;
      cleanup.apiStartupFailure = {
        pid: error.childPid,
        exit: error.cleanup,
        error: error.cleanupError,
      };
      if (
        error.cleanupError ||
        !error.cleanup ||
        !error.cleanup.gracefulExit ||
        error.cleanup.forcedKill ||
        (error.cleanup.exitCode !== null && error.cleanup.exitCode !== 0) ||
        ('exitedAfterKill' in error.cleanup && !error.cleanup.exitedAfterKill)
      )
        cleanupErrors.push('api-child-startup-cleanup');
    } else {
      apiChildLogs = readApiLogs();
    }
    failure =
      error instanceof Error
        ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, '[redacted-url]')
        : 'unknown failure';
  } finally {
    try {
      const childExit = await removeApi(child);
      cleanup.apiChild = childExit;
      if (
        !childExit.gracefulExit ||
        childExit.forcedKill ||
        (childExit.exitCode !== null && childExit.exitCode !== 0) ||
        ('exitedAfterKill' in childExit && !childExit.exitedAfterKill)
      )
        cleanupErrors.push('api-child-forced-kill');
    } catch {
      cleanupErrors.push('api-child');
    }
    const clean = async (name: string, action: () => Promise<number>) => {
      try {
        cleanup[name] = await action();
      } catch {
        cleanupErrors.push(name);
      }
    };
    if (ownerConnected) {
      if (created.adminIds.length) {
        await clean('auditRows', async () => {
          const r = await owner.query(
            'delete from operation_logs where admin_id = any($1::uuid[])',
            [created.adminIds],
          );
          return r.rowCount ?? 0;
        });
        await clean('adminRows', async () => {
          const r = await owner.query(
            'delete from admins where id = any($1::uuid[])',
            [created.adminIds],
          );
          return r.rowCount ?? 0;
        });
      }
      if (created.portalAccountIds.length) {
        await clean('portalAccountRows', async () => {
          const r = await owner.query(
            'delete from portal_accounts where id = any($1::uuid[])',
            [created.portalAccountIds],
          );
          return r.rowCount ?? 0;
        });
      }
    }
    if (authConnected && created.sessionIds.length) {
      await clean('sessionRows', async () => {
        const r = await auth.query(
          'delete from auth.session where id = any($1::text[])',
          [created.sessionIds],
        );
        return r.rowCount ?? 0;
      });
    }
    if (ownerConnected && created.userIds.length) {
      await clean('userRows', async () => {
        const r = await owner.query(
          'delete from auth."user" where id = any($1::text[])',
          [created.userIds],
        );
        return r.rowCount ?? 0;
      });
    }
    await Promise.allSettled([
      owner.end(),
      auth.end(),
      ...(appConnected ? [appClient.end()] : []),
    ]);
  }

  const measuredSamples = samples.filter(
    (sample) => sample.attempt === 'measured',
  );
  const summaries = [
    ...new Set(measuredSamples.map((sample) => sample.scenario)),
  ].map((scenario) => {
    const values = measuredSamples
      .filter((sample) => sample.scenario === scenario)
      .filter((sample) => sample.outcome === 'complete')
      .map((sample) => sample.elapsedMs);
    return {
      scenario,
      samples: values.length,
      failures: measuredSamples.filter(
        (sample) =>
          sample.scenario === scenario && sample.outcome !== 'complete',
      ).length,
      p50Ms: values.length ? median(values) : null,
      minMs: values.length ? Math.min(...values) : null,
      maxMs: values.length ? Math.max(...values) : null,
    };
  });
  const budgetViolations = measuredSamples.filter(
    (sample) => sample.outcome !== 'complete' || sample.elapsedMs >= 500,
  );
  const rssBytes = rssSamples.map((sample) => sample.rssBytes);
  console.log(
    JSON.stringify(
      {
        runId,
        database: PERF_DATABASE,
        fixtureTenantCode: TENANT_CODE,
        fixtureTenantId: tenantId,
        databaseProfile,
        fixtureFacts,
        dateRange: { from: FROM, to: TO },
        measurementClass: PREFLIGHT
          ? 'diagnostic preflight only; not PR 3 acceptance'
          : 'formal repeated HTTP measurement',
        transport:
          'real API child process, loopback HTTP, real signed cookie and auth/business database roles; full response consumed and schema parsed',
        rounds: ROUNDS,
        warmupsPerScenario: 1,
        pageSize: PAGE_SIZE,
        serverPid: child?.pid ?? null,
        apiStartupCleanup,
        apiStartupCleanupError,
        apiStartupChildPid,
        serverRss: {
          sampler:
            'macOS ps -o rss=, 250 ms polling; API child RSS only; client process excluded',
          samples: rssSamples.length,
          minBytes: rssBytes.length ? Math.min(...rssBytes) : null,
          maxBytes: rssBytes.length ? Math.max(...rssBytes) : null,
          trace: rssSamples,
        },
        identities: Object.fromEntries(
          Object.entries(identities).map(([kind, identity]) => [
            kind,
            identity
              ? {
                  profileId: identity.profileId,
                  userId: identity.userId,
                  sessionId: identity.sessionId,
                }
              : null,
          ]),
        ),
        createdRows: created,
        cleanup,
        cleanupErrors,
        failures: [
          ...(failure ? [{ message: errorText(failure) }] : []),
          ...samples
            .filter((sample) => sample.outcome !== 'complete')
            .map((sample) => ({ ...sample })),
        ],
        apiChildLogs: failure ? apiChildLogs : undefined,
        budget: {
          thresholdMs: 500,
          requests: measuredSamples.length,
          violations: budgetViolations,
        },
        samples,
        summaries,
        evidenceCaptureCommand: PREFLIGHT
          ? `cd apps/api && mkdir -p ${evidenceDirectory} && set -o pipefail && PERF_PREFLIGHT=1 PERF_ROUNDS=1 node --env-file-if-exists=../../.env --import tsx scripts/portal-list-perf.ts 2>&1 | tee ${evidenceDirectory}/list-preflight.txt`
          : `cd apps/api && mkdir -p ${evidenceDirectory} && set -o pipefail && PERF_TARGET_DATABASE=${PERF_DATABASE} PERF_TENANT_CODE=PORTALBIG PERF_ROUNDS=${ROUNDS} node --env-file-if-exists=../../.env --import tsx scripts/portal-list-perf.ts 2>&1 | tee ${evidenceDirectory}/list-latency.txt`,
      },
      null,
      2,
    ),
  );
  if (failure || cleanupErrors.length || budgetViolations.length)
    process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
