import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { resolve } from 'node:path';
import pg from 'pg';
import {
  PERF_DATABASE,
  inspectDatabaseProfile,
  insertIdentity,
  perfUrls,
  freePort,
  removeApi,
  startApi,
  startRssSampler,
  ApiStartupError,
  type ApiChildExit,
  type Audience,
  type CreatedRows,
  type DatabaseProfile,
  type ExportCompletedEvent,
  type Identity,
  type RssSample,
} from './portal-list-perf.js';

const DATABASE = PERF_DATABASE;
const PR3_PERF_DATABASE = 'fs_billing_perf_pr3_uuid_v4';
const FROM = '2026-09-01';
const TO = '2026-09-30';
const ROUNDS = Number(process.env.PERF_ROUNDS ?? 7);
const INCLUDE_SLOW = process.env.PERF_SLOW === '1';
const INCLUDE_DEADLINE = process.env.PERF_DEADLINE === '1';
const INCLUDE_CONCURRENCY = process.env.PERF_CONCURRENCY === '1';
const FULL_ACCEPTANCE = process.env.PERF_ACCEPTANCE === '1';
const IDLE_DIAGNOSTIC_ONLY = process.env.PERF_DIAGNOSTIC_IDLE_ONLY === '1';
const ISOLATED_RSS_SAMPLE = process.env.PERF_RSS_ISOLATED === '1';
const DIAGNOSTIC_PREFIX = (() => {
  const value = process.env.PERF_DIAGNOSTIC_PREFIX ?? 'none';
  if (
    value !== 'none' &&
    value !== 'fast' &&
    value !== 'abort' &&
    value !== 'fast-abort'
  )
    throw new Error(`Unsupported PERF_DIAGNOSTIC_PREFIX: ${value}`);
  return value;
})();
const TENANT_CODES = [
  'PORTALBIG',
  'EXPORT50K',
  'EXPORT100K',
  'EXPORT200K',
  'PORTALS3',
] as const;
const EXPECTED_FIXTURE_ROWS: Record<(typeof TENANT_CODES)[number], number> = {
  PORTALBIG: 3_000_000,
  EXPORT50K: 50_000,
  EXPORT100K: 100_000,
  EXPORT200K: 200_000,
  PORTALS3: 30_000,
};
const rssTenantCodeInput = process.env.PERF_RSS_TENANT ?? 'EXPORT50K';
const rssTenantMatch = TENANT_CODES.find((code) => code === rssTenantCodeInput);
if (!rssTenantMatch)
  throw new Error(`Unsupported PERF_RSS_TENANT: ${rssTenantCodeInput}`);
const RSS_TENANT_CODE: (typeof TENANT_CODES)[number] = rssTenantMatch;
const rssAudienceInput = process.env.PERF_RSS_AUDIENCE ?? 'portal';
if (rssAudienceInput !== 'portal' && rssAudienceInput !== 'admin')
  throw new Error(`Unsupported PERF_RSS_AUDIENCE: ${rssAudienceInput}`);
const RSS_AUDIENCE: Audience = rssAudienceInput;
const RSS_SAMPLE_ROUND = Number(process.env.PERF_RSS_ROUND ?? 1);
const RSS_SAMPLE_INTERVAL_MS = ISOLATED_RSS_SAMPLE ? 50 : 250;

type ExportResult = {
  scenario: string;
  requestId: string | null;
  attempt: 'warmup' | 'measured' | 'diagnostic';
  round: number;
  elapsedMs: number;
  outcome:
    | 'complete'
    | 'client-abort'
    | 'premature-close'
    | 'client-timeout'
    | 'http-error'
    | 'request-error';
  status: number | null;
  bytes: number;
  crlfRecords: number;
  csvDataRows: number;
  contentType: string | null;
  attachment: string | null;
  hasUtf8Bom: boolean;
  hasContentLength: boolean;
  responseEndElapsedMs: number | null;
  responseAbortedElapsedMs: number | null;
  responseCloseElapsedMs: number | null;
  socketCloseElapsedMs: number | null;
  error: string | null;
  bodySummary: {
    bytes: number;
    contentType: string | null;
    apiErrorCode?: string;
  } | null;
};
type ResponseControl = {
  requestId: string | null;
  status: number | null;
  unthrottle: () => void;
};
type RssTrace = {
  scenario: string;
  round: number;
  rss: RssSample[];
  startBytes: number | null;
  peakBytes: number | null;
  deltaBytes: number | null;
};
type ExportActivity = {
  connections: number;
  idleInTransaction: number;
  activeOrWaiting: number;
  cancelConnections: number;
  sessions: {
    pid: number;
    applicationName: string;
    state: string | null;
    stateChange: string;
    waitEventType: string | null;
    waitEvent: string | null;
    backendStart: string;
    queryStart: string | null;
    transactionStart: string | null;
    queryText: string;
  }[];
};
type TimedExportActivity = {
  elapsedMs: number;
  sampledAtUtc: string;
  request: ExportActivity;
  all: ExportActivity;
};

function summaryNumberMedian(values: number[]) {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  const value =
    ordered.length % 2
      ? (ordered[middle] ?? 0)
      : ((ordered[middle - 1] ?? 0) + (ordered[middle] ?? 0)) / 2;
  return Number(value.toFixed(1));
}

async function observeExportActivity(owner: pg.Client, requestId?: string) {
  const applicationName = requestId
    ? `fsbilling-api-export:${requestId}`
    : null;
  const result = await owner.query<{
    connections: string;
    idle_in_transaction: string;
    active_or_waiting: string;
    cancel_connections: string;
  }>(
    `select
       count(*) filter (where (($2::text is null and (application_name='fsbilling-api-export' or application_name like 'fsbilling-api-export:%')) or application_name=$2 or ($2::text is not null and application_name='fsbilling-api-export')))::text as connections,
       count(*) filter (where ((($2::text is null and (application_name='fsbilling-api-export' or application_name like 'fsbilling-api-export:%')) or application_name=$2 or ($2::text is not null and application_name='fsbilling-api-export')) and state='idle in transaction'))::text as idle_in_transaction,
       count(*) filter (where ((($2::text is null and (application_name='fsbilling-api-export' or application_name like 'fsbilling-api-export:%')) or application_name=$2 or ($2::text is not null and application_name='fsbilling-api-export')) and state is distinct from 'idle'))::text as active_or_waiting,
       count(*) filter (where application_name='fsbilling-api-export-cancel')::text as cancel_connections
     from pg_stat_activity where datname=$1`,
    [DATABASE, applicationName],
  );
  const row = result.rows[0];
  assert(row);
  const sessions = await owner.query<{
    pid: number;
    applicationName: string;
    state: string | null;
    stateChange: string;
    waitEventType: string | null;
    waitEvent: string | null;
    backendStart: string;
    queryStart: string | null;
    transactionStart: string | null;
    queryText: string;
  }>(
    `select pid, application_name as "applicationName", state,
       state_change::text as "stateChange",
       wait_event_type as "waitEventType", wait_event as "waitEvent",
       backend_start::text as "backendStart", query_start::text as "queryStart",
       xact_start::text as "transactionStart", left(query, 1000) as "queryText"
     from pg_stat_activity
     where datname=$1 and (
       (($2::text is null) and (application_name='fsbilling-api-export' or application_name like 'fsbilling-api-export:%'))
       or application_name=$2
       or ($2::text is not null and application_name='fsbilling-api-export')
       or application_name='fsbilling-api-export-cancel'
     ) order by pid`,
    [DATABASE, applicationName],
  );
  return {
    connections: Number(row.connections),
    idleInTransaction: Number(row.idle_in_transaction),
    activeOrWaiting: Number(row.active_or_waiting),
    cancelConnections: Number(row.cancel_connections),
    sessions: sessions.rows,
  };
}

async function waitForExportCleanup(owner: pg.Client, timeoutMs = 10_000) {
  const started = performance.now();
  let last = await observeExportActivity(owner);
  while (
    last.idleInTransaction > 0 ||
    last.activeOrWaiting > 0 ||
    last.cancelConnections > 0
  ) {
    if (performance.now() - started >= timeoutMs) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await observeExportActivity(owner);
  }
  return last;
}

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

function responseSummary(
  prefix: Buffer,
  bytes: number,
  contentType: string | null,
) {
  let apiErrorCode: string | undefined;
  try {
    const body: unknown = JSON.parse(prefix.toString('utf8'));
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
    // Preserve only metadata; response chunks may contain customer data.
  }
  return {
    bytes,
    contentType,
    ...(apiErrorCode ? { apiErrorCode } : {}),
  };
}

function summary(values: ExportResult[]) {
  const durations = values
    .map((value) => value.elapsedMs)
    .sort((left, right) => left - right);
  assert(durations.length > 0);
  const middle = Math.floor(durations.length / 2);
  const p50 =
    durations.length % 2
      ? (durations[middle] ?? 0)
      : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
  return {
    samples: values.length,
    p50Ms: Number(p50.toFixed(1)),
    minMs: Math.min(...durations),
    maxMs: Math.max(...durations),
    totalRows: values.map((value) => value.csvDataRows),
    statuses: values.map((value) => value.status),
    outcomes: values.map((value) => value.outcome),
  };
}

function countCrlf(chunk: Buffer, priorWasCr: boolean) {
  let records = 0;
  let wasCr = priorWasCr;
  for (const byte of chunk) {
    if (wasCr && byte === 0x0a) records += 1;
    wasCr = byte === 0x0d;
  }
  return { records, trailingCr: wasCr };
}

function streamCsv({
  origin,
  path,
  cookie,
  scenario,
  rateBytesPerSecond,
  abortAfterBytes,
  maxDurationMs = 120_000,
  progress,
  onStatus,
  onResponseControl,
  holdUntilUnthrottle = false,
}: {
  origin: string;
  path: string;
  cookie: string;
  scenario: string;
  rateBytesPerSecond?: number;
  abortAfterBytes?: number;
  maxDurationMs?: number;
  progress: (bytes: number, records: number) => void;
  onStatus?: (status: number | null) => void;
  onResponseControl?: (control: ResponseControl) => void;
  holdUntilUnthrottle?: boolean;
}): Promise<ExportResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let status: number | null = null;
    let responseSocket: Socket | undefined;
    let socketCloseListener: (() => void) | undefined;
    let requestId: string | null = null;
    let bytes = 0;
    let records = 0;
    let trailingCr = false;
    let prefix = Buffer.alloc(0);
    let errorBodyPrefix = Buffer.alloc(0);
    let contentType: string | null = null;
    let attachment: string | null = null;
    let hasContentLength = false;
    let responseEndElapsedMs: number | null = null;
    let responseAbortedElapsedMs: number | null = null;
    let responseCloseElapsedMs: number | null = null;
    let socketCloseElapsedMs: number | null = null;
    let error: string | null = null;
    let settled = false;
    let gotEnd = false;
    let clientTimeoutRequested = false;
    let activeRateBytesPerSecond = rateBytesPerSecond;
    let responseHeld = false;
    let throttle: NodeJS.Timeout | undefined;
    let timeoutFinalizer: NodeJS.Timeout | undefined;
    let prematureCloseFinalizer: NodeJS.Timeout | undefined;
    const finish = (outcome: ExportResult['outcome']) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (throttle) clearTimeout(throttle);
      if (timeoutFinalizer) clearTimeout(timeoutFinalizer);
      if (prematureCloseFinalizer) clearTimeout(prematureCloseFinalizer);
      if (responseSocket && socketCloseListener)
        responseSocket.removeListener('close', socketCloseListener);
      resolve({
        scenario,
        attempt: 'diagnostic',
        round: 0,
        requestId,
        elapsedMs: Number((performance.now() - started).toFixed(1)),
        outcome,
        status,
        bytes,
        crlfRecords: records,
        csvDataRows: Math.max(0, records - 1),
        contentType,
        attachment,
        hasUtf8Bom: prefix
          .subarray(0, 3)
          .equals(Buffer.from([0xef, 0xbb, 0xbf])),
        hasContentLength,
        responseEndElapsedMs,
        responseAbortedElapsedMs,
        responseCloseElapsedMs,
        socketCloseElapsedMs,
        error,
        bodySummary:
          status !== null && status !== 200
            ? responseSummary(errorBodyPrefix, bytes, contentType)
            : null,
      });
    };
    const request = httpRequest(new URL(path, origin), {
      method: 'POST',
      headers: {
        cookie,
        origin,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
        accept: 'text/csv',
      },
    });
    const deadline = setTimeout(() => {
      clientTimeoutRequested = true;
      error = `client did not finish within ${maxDurationMs}ms`;
      request.destroy();
      timeoutFinalizer = setTimeout(() => finish('client-timeout'), 2_000);
    }, maxDurationMs);
    request.on('response', (response: IncomingMessage) => {
      status = response.statusCode ?? null;
      const requestIdHeader = response.headers['x-request-id'];
      requestId = Array.isArray(requestIdHeader)
        ? (requestIdHeader[0] ?? null)
        : (requestIdHeader ?? null);
      onStatus?.(status);
      contentType = response.headers['content-type'] ?? null;
      attachment = response.headers['content-disposition'] ?? null;
      hasContentLength = response.headers['content-length'] !== undefined;
      onResponseControl?.({
        requestId,
        status,
        unthrottle: () => {
          activeRateBytesPerSecond = undefined;
          if (throttle) {
            clearTimeout(throttle);
            throttle = undefined;
          }
          response.resume();
        },
      });
      responseSocket = response.socket ?? undefined;
      if (responseSocket) {
        socketCloseListener = () => {
          socketCloseElapsedMs = Number(
            (performance.now() - started).toFixed(1),
          );
        };
        responseSocket.once('close', socketCloseListener);
      }
      response.on('data', (value: Buffer | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        bytes += chunk.length;
        if (status !== 200 && errorBodyPrefix.length < 2048)
          errorBodyPrefix = Buffer.concat([
            errorBodyPrefix,
            chunk.subarray(0, 2048 - errorBodyPrefix.length),
          ]);
        if (prefix.length < 3)
          prefix = Buffer.concat([
            prefix,
            chunk.subarray(0, 3 - prefix.length),
          ]);
        const counted = countCrlf(chunk, trailingCr);
        records += counted.records;
        trailingCr = counted.trailingCr;
        progress(bytes, records);
        if (abortAfterBytes !== undefined && bytes >= abortAfterBytes) {
          response.pause();
          error = `client intentionally aborted after ${bytes} bytes`;
          finish('client-abort');
          request.destroy();
          return;
        }
        if (holdUntilUnthrottle && !responseHeld) {
          response.pause();
          responseHeld = true;
        } else if (activeRateBytesPerSecond && activeRateBytesPerSecond > 0) {
          response.pause();
          throttle = setTimeout(
            () => response.resume(),
            (chunk.length / activeRateBytesPerSecond) * 1000,
          );
        }
      });
      response.on('end', () => {
        gotEnd = true;
        responseEndElapsedMs = Number((performance.now() - started).toFixed(1));
        if (status !== 200) error = `HTTP ${status ?? 'unknown'}`;
        finish(status === 200 ? 'complete' : 'http-error');
      });
      response.on('aborted', () => {
        responseAbortedElapsedMs = Number(
          (performance.now() - started).toFixed(1),
        );
        error ??= 'HTTP response aborted before end';
        if (!clientTimeoutRequested && !prematureCloseFinalizer)
          prematureCloseFinalizer = setTimeout(
            () => finish('premature-close'),
            2_000,
          );
      });
      response.on('error', (caught: Error) => {
        error = errorText(caught);
        if (!clientTimeoutRequested && !prematureCloseFinalizer)
          prematureCloseFinalizer = setTimeout(
            () => finish('premature-close'),
            2_000,
          );
      });
      response.on('close', () => {
        responseCloseElapsedMs = Number(
          (performance.now() - started).toFixed(1),
        );
        if (!gotEnd) {
          error ??= 'HTTP response closed before end';
          setImmediate(() =>
            finish(
              clientTimeoutRequested ? 'client-timeout' : 'premature-close',
            ),
          );
        }
      });
    });
    request.on('error', () => {
      if (abortAfterBytes !== undefined && bytes >= abortAfterBytes)
        finish('client-abort');
      else if (!settled && !clientTimeoutRequested) {
        error = 'HTTP request socket failed';
        finish('premature-close');
      }
    });
    request.end(JSON.stringify({ from: FROM, to: TO, status: 'answered' }));
  });
}

async function findTenantIds(owner: pg.Client) {
  const result = await owner.query<{
    id: string;
    code: (typeof TENANT_CODES)[number];
  }>(`select id::text, code from tenants where code = any($1::text[])`, [
    TENANT_CODES,
  ]);
  const tenants = new Map(result.rows.map((row) => [row.code, row]));
  for (const code of TENANT_CODES) {
    const row = tenants.get(code);
    assert(row, `missing ${code} synthetic fixture in ${DATABASE}`);
  }
  return tenants;
}

async function countExpectedPortalBigExportRows(
  owner: pg.Client,
  tenantId: string,
) {
  const result = await owner.query<{ total: number }>(
    `with bounds as (
       select ($2::date)::timestamp at time zone 'Asia/Shanghai' as lo,
         (($3::date + 1))::timestamp at time zone 'Asia/Shanghai' as hi
     )
     select count(*)::int as total from cdrs c cross join bounds b
     where c.tenant_id=$1::uuid and c.answered_at >= b.lo and c.answered_at < b.hi
       and c.started_at >= b.lo - interval '31 days' and c.started_at < b.hi`,
    [tenantId, FROM, TO],
  );
  const total = result.rows[0]?.total;
  assert(total !== undefined && total > 0);
  return total;
}

async function assertConnectionIdentity(
  client: pg.Client,
  expectedRole: string,
) {
  const result = await client.query<{
    database: string;
    role: string;
  }>('select current_database() as database, current_user as role');
  const identity = result.rows[0];
  assert(identity, `${expectedRole} connection returned no identity`);
  assert.equal(identity.database, DATABASE);
  assert.equal(identity.role, expectedRole);
  return identity;
}

async function sampleRssAfterGc(pid: number, getRows: () => number) {
  const before = startRssSampler(pid, getRows, 50);
  await new Promise((resolve) => setTimeout(resolve, 200));
  before.stop();
  process.kill(pid, 'SIGUSR2');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const after = startRssSampler(pid, getRows, 50);
  await new Promise((resolve) => setTimeout(resolve, 400));
  after.stop();
  const beforeBytes = before.samples.map((sample) => sample.rssBytes);
  const afterBytes = after.samples.map((sample) => sample.rssBytes);
  return {
    rssBeforeGc: before.samples.at(-1) ?? null,
    rssAfterGc: after.samples.at(-1) ?? null,
    peakBeforeGc: beforeBytes.length ? Math.max(...beforeBytes) : null,
    peakAfterGc: afterBytes.length ? Math.max(...afterBytes) : null,
  };
}

async function queryExport(
  origin: string,
  tenantId: string,
  audience: Audience,
  identity: Identity,
  progress: (bytes: number, records: number) => void,
  options: {
    rateBytesPerSecond?: number;
    abortAfterBytes?: number;
    maxDurationMs?: number;
    onStatus?: (status: number | null) => void;
    attempt?: ExportResult['attempt'];
    round?: number;
    onResponseControl?: (control: ResponseControl) => void;
    holdUntilUnthrottle?: boolean;
  } = {},
): Promise<ExportResult> {
  const started = performance.now();
  const { attempt = 'diagnostic', round = 0, ...streamOptions } = options;
  const path =
    audience === 'portal'
      ? '/api/portal/cdrs/export'
      : `/api/admin/tenants/${tenantId}/cdrs/export`;
  try {
    const result = await streamCsv({
      origin,
      path,
      cookie: identity.cookie,
      scenario: `${audience}-${tenantId}`,
      progress,
      ...streamOptions,
    });
    return { ...result, attempt, round };
  } catch (error) {
    return {
      scenario: `${audience}-${tenantId}`,
      attempt,
      round,
      requestId: null,
      elapsedMs: Number((performance.now() - started).toFixed(1)),
      outcome: 'request-error',
      status: null,
      bytes: 0,
      crlfRecords: 0,
      csvDataRows: 0,
      contentType: null,
      attachment: null,
      hasUtf8Bom: false,
      hasContentLength: false,
      responseEndElapsedMs: null,
      responseAbortedElapsedMs: null,
      responseCloseElapsedMs: null,
      socketCloseElapsedMs: null,
      error: errorText(error),
      bodySummary: null,
    };
  }
}

async function observeIdleTimeout(
  origin: string,
  tenantId: string,
  identity: Identity,
  owner: pg.Client,
  readEvents: () => ExportCompletedEvent[],
  rateBytesPerSecond = 1000,
  maxDurationMs = 90_000,
  serverWaitTimeoutMs = 45_000,
  expectedServerResult = 'database_error',
  priorRequests: readonly ExportResult[] = [],
  holdUntilServerCompletion = false,
) {
  const started = performance.now();
  const requestStartedAtUtc = new Date().toISOString();
  const activity: TimedExportActivity[] = [];
  const priorServerCompletions: {
    requestId: string;
    event: ExportCompletedEvent;
    firstObservedElapsedMs: number;
    clientOutcome?: ExportResult['outcome'];
    clientElapsedMs?: number;
    completionLagAfterClientMs?: number;
  }[] = [];
  const seenPriorCompletions = new Set<string>();
  const errors: string[] = [];
  const priorRequestsById = new Map(
    priorRequests.flatMap((request) =>
      request.requestId ? [[request.requestId, request] as const] : [],
    ),
  );
  let resolveResponseControl: (control: ResponseControl) => void = () =>
    undefined;
  const responseControlPromise = new Promise<ResponseControl>((resolve) => {
    resolveResponseControl = resolve;
  });
  const request = queryExport(
    origin,
    tenantId,
    'portal',
    identity,
    () => undefined,
    {
      rateBytesPerSecond,
      maxDurationMs,
      attempt: 'diagnostic',
      round: 1,
      onResponseControl: resolveResponseControl,
      holdUntilUnthrottle: holdUntilServerCompletion,
    },
  );
  const responseControl = await Promise.race([
    responseControlPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  const requestId = responseControl?.requestId ?? null;
  const serverWaitStarted = performance.now();
  let serverCompletion: ExportCompletedEvent | null = null;
  while (
    responseControl &&
    requestId &&
    serverCompletion === null &&
    performance.now() - serverWaitStarted < serverWaitTimeoutMs
  ) {
    serverCompletion =
      readEvents().find((event) => event.requestId === requestId) ?? null;
    if (serverCompletion) break;
    try {
      const requestActivity = await observeExportActivity(owner, requestId);
      const allActivity = await observeExportActivity(owner);
      activity.push({
        elapsedMs: Math.round(performance.now() - started),
        sampledAtUtc: new Date().toISOString(),
        request: requestActivity,
        all: allActivity,
      });
      const observedAtElapsedMs = Math.round(performance.now() - started);
      for (const priorRequestId of priorRequestsById.keys()) {
        if (seenPriorCompletions.has(priorRequestId)) continue;
        const priorEvent = readEvents().find(
          (event) => event.requestId === priorRequestId,
        );
        if (!priorEvent) continue;
        seenPriorCompletions.add(priorRequestId);
        const priorRequest = priorRequestsById.get(priorRequestId);
        priorServerCompletions.push({
          requestId: priorRequestId,
          event: priorEvent,
          firstObservedElapsedMs: observedAtElapsedMs,
          ...(priorRequest ? { clientOutcome: priorRequest.outcome } : {}),
          ...(priorRequest ? { clientElapsedMs: priorRequest.elapsedMs } : {}),
          completionLagAfterClientMs: Number(
            (
              priorEvent.elapsedMs -
              (priorRequest?.elapsedMs ?? priorEvent.elapsedMs)
            ).toFixed(1),
          ),
        });
      }
    } catch (error) {
      errors.push(errorText(error));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const serverWaitElapsedMs = Math.round(performance.now() - serverWaitStarted);
  const pgAtServerCompletion = serverCompletion
    ? await observeExportActivity(owner, requestId ?? undefined).catch(
        (error: unknown) => {
          errors.push(errorText(error));
          return null;
        },
      )
    : null;
  const afterServerCompletion = serverCompletion
    ? await waitForExportCleanup(owner)
    : null;
  const serverPoolCleanBeforeUnthrottle =
    afterServerCompletion !== null &&
    afterServerCompletion.idleInTransaction === 0 &&
    afterServerCompletion.activeOrWaiting === 0 &&
    afterServerCompletion.cancelConnections === 0;
  const unthrottleElapsedMs = responseControl
    ? Number((performance.now() - started).toFixed(1))
    : null;
  responseControl?.unthrottle();
  const result = await Promise.race([
    request,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
  const afterRequest = await waitForExportCleanup(owner);
  for (const priorRequestId of priorRequestsById.keys()) {
    if (seenPriorCompletions.has(priorRequestId)) continue;
    const priorEvent = readEvents().find(
      (event) => event.requestId === priorRequestId,
    );
    if (!priorEvent) continue;
    const priorRequest = priorRequestsById.get(priorRequestId);
    seenPriorCompletions.add(priorRequestId);
    priorServerCompletions.push({
      requestId: priorRequestId,
      event: priorEvent,
      firstObservedElapsedMs: Math.round(performance.now() - started),
      ...(priorRequest ? { clientOutcome: priorRequest.outcome } : {}),
      ...(priorRequest ? { clientElapsedMs: priorRequest.elapsedMs } : {}),
      completionLagAfterClientMs: Number(
        (
          priorEvent.elapsedMs -
          (priorRequest?.elapsedMs ?? priorEvent.elapsedMs)
        ).toFixed(1),
      ),
    });
  }
  let serverCompletionError: string | null = null;
  if (!responseControl)
    serverCompletionError = 'no HTTP response headers/request ID before 5s';
  else if (!requestId)
    serverCompletionError = 'response has no x-request-id header';
  else if (!serverCompletion)
    serverCompletionError = `no matching server completion event in ${serverWaitTimeoutMs}ms`;
  const matchingIdleSessions = activity.flatMap((sample) =>
    sample.request.sessions.filter(
      (session) => session.state === 'idle in transaction',
    ),
  );
  const latestIdleStateChange = matchingIdleSessions.at(-1)?.stateChange;
  const continuousIdleMsAtServerCompletion =
    serverCompletion && latestIdleStateChange
      ? Math.round(
          Date.parse(requestStartedAtUtc) +
            serverCompletion.elapsedMs -
            Date.parse(latestIdleStateChange),
        )
      : null;
  const maxObservedContinuousIdleMs = Math.max(
    0,
    ...activity.flatMap((sample) =>
      sample.request.sessions
        .filter((session) => session.state === 'idle in transaction')
        .map((session) =>
          Math.max(
            0,
            Date.parse(sample.sampledAtUtc) - Date.parse(session.stateChange),
          ),
        ),
    ),
  );
  return {
    result,
    requestId,
    requestStartedAtUtc,
    serverWaitElapsedMs,
    serverCompletion,
    expectedServerResult,
    serverCompletionError,
    continuousIdleMsAtServerCompletion,
    maxObservedContinuousIdleMs,
    activity,
    priorServerCompletions,
    activityErrors: errors,
    pgAtServerCompletion,
    afterServerCompletion,
    serverPoolCleanBeforeUnthrottle,
    unthrottleElapsedMs,
    afterRequest,
  };
}

async function readAuditIds(
  owner: pg.Client,
  adminId: string,
): Promise<string[]> {
  const result = await owner.query<{ id: string }>(
    `select id::text from operation_logs where admin_id=$1::uuid and action='cdr_export' order by created_at,id`,
    [adminId],
  );
  return result.rows.map((row) => row.id);
}

async function deleteAuditRows(
  owner: pg.Client,
  adminId: string,
  expectedIds: string[],
): Promise<number> {
  await owner.query('begin');
  try {
    await owner.query(
      'lock table public.operation_logs in share row exclusive mode',
    );
    const trigger = await owner.query<{ enabled: string }>(
      `select tgenabled as enabled from pg_trigger
       where tgrelid='public.operation_logs'::regclass
         and tgname='operation_logs_append_only' and not tgisinternal`,
    );
    assert.equal(trigger.rows[0]?.enabled, 'O');
    const currentIds = await owner.query<{ id: string }>(
      `select id::text from public.operation_logs
       where admin_id=$1::uuid and action='cdr_export' order by id`,
      [adminId],
    );
    assert.deepEqual(
      currentIds.rows.map((row) => row.id).sort(),
      [...expectedIds].sort(),
      'only this run admin’s recorded cdr_export audit rows may be cleaned',
    );
    if (expectedIds.length > 0) {
      await owner.query(
        'alter table public.operation_logs disable trigger operation_logs_append_only',
      );
      const deleted = await owner.query(
        `delete from public.operation_logs
         where id=any($1::uuid[]) and admin_id=$2::uuid and action='cdr_export'`,
        [expectedIds, adminId],
      );
      assert.equal(deleted.rowCount, expectedIds.length);
      await owner.query(
        'alter table public.operation_logs enable trigger operation_logs_append_only',
      );
    }
    const triggerAfter = await owner.query<{ enabled: string }>(
      `select tgenabled as enabled from pg_trigger
       where tgrelid='public.operation_logs'::regclass
         and tgname='operation_logs_append_only' and not tgisinternal`,
    );
    assert.equal(triggerAfter.rows[0]?.enabled, trigger.rows[0]?.enabled);
    const remaining = await owner.query<{ rows: string }>(
      `select count(*)::text as rows from public.operation_logs
       where id=any($1::uuid[])`,
      [expectedIds],
    );
    assert.equal(remaining.rows[0]?.rows, '0');
    await owner.query('commit');
    return expectedIds.length;
  } catch (error) {
    await owner.query('rollback').catch(() => undefined);
    throw error;
  }
}

async function main() {
  if (ISOLATED_RSS_SAMPLE) {
    assert.equal(IDLE_DIAGNOSTIC_ONLY, false);
    assert.equal(FULL_ACCEPTANCE, false);
    assert.equal(INCLUDE_SLOW, false);
    assert.equal(INCLUDE_DEADLINE, false);
    assert.equal(INCLUDE_CONCURRENCY, false);
    assert.equal(ROUNDS, 1);
    assert(Number.isInteger(RSS_SAMPLE_ROUND) && RSS_SAMPLE_ROUND >= 1);
    assert.equal(DATABASE, PR3_PERF_DATABASE);
  } else if (IDLE_DIAGNOSTIC_ONLY) {
    assert.equal(FULL_ACCEPTANCE, false);
    assert.equal(INCLUDE_SLOW, false);
    assert.equal(INCLUDE_DEADLINE, false);
    assert.equal(INCLUDE_CONCURRENCY, false);
    assert.equal(ROUNDS, 1);
    assert.equal(
      DATABASE,
      PR3_PERF_DATABASE,
      'idle-prefix diagnostics must target fs_billing_perf_pr3_uuid_v4',
    );
  } else {
    assert.equal(
      DIAGNOSTIC_PREFIX,
      'none',
      'PERF_DIAGNOSTIC_PREFIX requires PERF_DIAGNOSTIC_IDLE_ONLY=1',
    );
    assert(
      Number.isInteger(ROUNDS) && ROUNDS >= 5,
      'PERF_ROUNDS must be at least 5',
    );
  }
  if (FULL_ACCEPTANCE)
    assert(
      INCLUDE_SLOW && INCLUDE_DEADLINE && INCLUDE_CONCURRENCY,
      'PERF_ACCEPTANCE=1 requires PERF_SLOW=1 PERF_DEADLINE=1 and PERF_CONCURRENCY=1',
    );
  if (FULL_ACCEPTANCE)
    assert.equal(
      DATABASE,
      PR3_PERF_DATABASE,
      'formal export acceptance must target fs_billing_perf_pr3_uuid_v4',
    );
  const evidenceDirectory = resolve(
    process.cwd(),
    '../../docs/evidence/phase-6',
  );
  const formalEvidencePath = resolve(
    evidenceDirectory,
    'export-formal-pr3-20261019T1051Z-stream-hold-r2.jsonl',
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
  const identities: {
    admin?: Identity;
    portalBig?: Identity;
    portal50k?: Identity;
    portal100k?: Identity;
    portal200k?: Identity;
    rss?: Identity;
  } = {};
  const results: ExportResult[] = [];
  const rssTraces: RssTrace[] = [];
  const rssRows: RssSample[] = [];
  const observations: Record<string, unknown>[] = [];
  let deadlineRateBasis:
    | {
        sourceScenario: string;
        measuredRounds: number;
        measuredBytes: number;
        fetchBatchSizeRows: 5000;
        batches: 40;
        targetSecondsPerBatch: 15;
        rateBytesPerSecond: number;
        projected200kClientMs: number;
      }
    | undefined;
  let child: import('node:child_process').ChildProcess | undefined;
  let readApiExportEvents: () => ExportCompletedEvent[];
  let apiStartupCleanup: ApiChildExit | null | undefined;
  let apiStartupCleanupError: string | null | undefined;
  let apiStartupChildPid: number | null | undefined;
  let apiStartupDiagnostics: string | undefined;
  let apiStartupEvents: ExportCompletedEvent[] | undefined;
  let failure: string | undefined;
  const cleanup: Record<string, unknown> = {};
  const cleanupErrors: string[] = [];
  let tenantRows = new Map<
    (typeof TENANT_CODES)[number],
    { id: string; code: (typeof TENANT_CODES)[number] }
  >();
  let origin: string | undefined;
  let ownerConnected = false;
  let authConnected = false;
  let appConnected = false;
  let databaseProfile: DatabaseProfile | undefined;
  let connectionIdentities:
    | {
        owner: { database: string; role: string };
        auth: { database: string; role: string };
        app: { database: string; role: string };
      }
    | undefined;
  let fixtureCounts: Record<string, number> = {};
  let expectedPortalBigExportRows = 0;
  try {
    await owner.connect();
    ownerConnected = true;
    await auth.connect();
    authConnected = true;
    await appClient.connect();
    appConnected = true;
    const [ownerIdentity, authIdentity] = await Promise.all([
      assertConnectionIdentity(owner, 'fs_billing'),
      assertConnectionIdentity(auth, 'fs_billing_auth'),
    ]);
    let appIdentity: { database: string; role: string };
    if (ISOLATED_RSS_SAMPLE) {
      appIdentity = await assertConnectionIdentity(appClient, 'fs_billing_app');
    } else {
      databaseProfile = await inspectDatabaseProfile(owner, appClient);
      appIdentity = {
        database: databaseProfile.database,
        role: databaseProfile.role,
      };
    }
    connectionIdentities = {
      owner: ownerIdentity,
      auth: authIdentity,
      app: appIdentity,
    };
    tenantRows = await findTenantIds(owner);
    const countedTenants = ISOLATED_RSS_SAMPLE
      ? [tenantRows.get(RSS_TENANT_CODE)].filter(
          (tenant): tenant is NonNullable<typeof tenant> =>
            tenant !== undefined,
        )
      : [...tenantRows.values()];
    assert.equal(
      countedTenants.length,
      ISOLATED_RSS_SAMPLE ? 1 : TENANT_CODES.length,
    );
    const fixtureCountsResult = await owner.query<{
      tenant_id: string;
      total: string;
    }>(
      'select tenant_id::text, count(*)::text as total from cdrs where tenant_id = any($1::uuid[]) group by tenant_id',
      [countedTenants.map((tenant) => tenant.id)],
    );
    const codeById = new Map(
      [...tenantRows].map(([code, tenant]) => [tenant.id, code]),
    );
    fixtureCounts = Object.fromEntries(
      fixtureCountsResult.rows.map((row) => [
        codeById.get(row.tenant_id) ?? row.tenant_id,
        Number(row.total),
      ]),
    );
    const expectedFixtureCodes = ISOLATED_RSS_SAMPLE
      ? [RSS_TENANT_CODE]
      : TENANT_CODES;
    for (const code of expectedFixtureCodes) {
      const expected = EXPECTED_FIXTURE_ROWS[code];
      assert.equal(
        fixtureCounts[code],
        expected,
        `${code} CDR fixture row count differs from its declared profile`,
      );
    }
    const tenant = tenantRows.get('PORTALBIG');
    const export50k = tenantRows.get('EXPORT50K');
    const export100k = tenantRows.get('EXPORT100K');
    const export200k = tenantRows.get('EXPORT200K');
    assert(tenant && export50k && export100k && export200k);
    if (!ISOLATED_RSS_SAMPLE || RSS_TENANT_CODE === 'PORTALBIG')
      expectedPortalBigExportRows = await countExpectedPortalBigExportRows(
        owner,
        tenant.id,
      );
    const secret = process.env.BETTER_AUTH_SECRET;
    assert(
      secret && Buffer.byteLength(secret) >= 32,
      'BETTER_AUTH_SECRET is unavailable or too short',
    );
    if (ISOLATED_RSS_SAMPLE) {
      const fixture = tenantRows.get(RSS_TENANT_CODE);
      assert(fixture);
      identities.rss = await insertIdentity(
        owner,
        auth,
        fixture.id,
        RSS_AUDIENCE,
        runId,
        secret,
        created,
      );
    } else {
      identities.portalBig = await insertIdentity(
        owner,
        auth,
        tenant.id,
        'portal',
        runId,
        secret,
        created,
      );
    }
    if (!IDLE_DIAGNOSTIC_ONLY && !ISOLATED_RSS_SAMPLE) {
      identities.portal100k = await insertIdentity(
        owner,
        auth,
        export100k.id,
        'portal',
        runId,
        secret,
        created,
      );
      identities.portal50k = await insertIdentity(
        owner,
        auth,
        export50k.id,
        'portal',
        runId,
        secret,
        created,
      );
      identities.portal200k = await insertIdentity(
        owner,
        auth,
        export200k.id,
        'portal',
        runId,
        secret,
        created,
      );
      identities.admin = await insertIdentity(
        owner,
        auth,
        tenant.id,
        'admin',
        runId,
        secret,
        created,
      );
    }

    const port = await freePort();
    const started = await startApi(port);
    child = started.child;
    origin = started.origin;
    readApiExportEvents = started.exportEvents;

    const fastCases: Array<{
      tenantCode: (typeof TENANT_CODES)[number];
      audience: Audience;
      identity: Identity | undefined;
      rounds: number;
    }> = [
      {
        tenantCode: 'EXPORT50K',
        audience: 'admin' as const,
        identity: identities.admin,
        rounds: ROUNDS,
      },
      {
        tenantCode: 'EXPORT50K',
        audience: 'portal' as const,
        identity: identities.portal50k,
        rounds: ROUNDS,
      },
      {
        tenantCode: 'EXPORT100K',
        audience: 'admin' as const,
        identity: identities.admin,
        rounds: ROUNDS,
      },
      {
        tenantCode: 'EXPORT100K',
        audience: 'portal' as const,
        identity: identities.portal100k,
        rounds: ROUNDS,
      },
      {
        tenantCode: 'EXPORT200K',
        audience: 'admin' as const,
        identity: identities.admin,
        rounds: ROUNDS,
      },
      {
        tenantCode: 'EXPORT200K',
        audience: 'portal' as const,
        identity: identities.portal200k,
        rounds: ROUNDS,
      },
    ];
    if (ISOLATED_RSS_SAMPLE) {
      const fixture = tenantRows.get(RSS_TENANT_CODE);
      const identity = identities.rss;
      assert(fixture && identity && origin && child?.pid);
      let receivedRows = 0;
      const repeats = Number(process.env.PERF_RSS_REPEAT ?? 1);
      assert(Number.isInteger(repeats) && repeats >= 1);
      const expectedRows =
        RSS_TENANT_CODE === 'PORTALBIG'
          ? expectedPortalBigExportRows
          : EXPECTED_FIXTURE_ROWS[RSS_TENANT_CODE];
      const scenario = `${RSS_AUDIENCE}-${RSS_TENANT_CODE}`;
      let result: ExportResult | undefined;
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        receivedRows = 0;
        const rss = startRssSampler(
          child.pid,
          () => receivedRows,
          RSS_SAMPLE_INTERVAL_MS,
        );
        result = await queryExport(
          origin,
          fixture.id,
          RSS_AUDIENCE,
          identity,
          (_bytes, records) => {
            receivedRows = Math.max(0, records - 1);
          },
          {
            attempt: 'measured',
            round: repeat,
            maxDurationMs: 30_000,
          },
        );
        rss.stop();
        const recordedRound = repeats === 1 ? RSS_SAMPLE_ROUND : repeat;
        results.push({ ...result, scenario, round: recordedRound });
        rssRows.push(...rss.samples);
        const bytes = rss.samples.map((sample) => sample.rssBytes);
        rssTraces.push({
          scenario,
          round: recordedRound,
          rss: rss.samples,
          startBytes: bytes[0] ?? null,
          peakBytes: bytes.length ? Math.max(...bytes) : null,
          deltaBytes: bytes.length
            ? Math.max(...bytes) - (bytes[0] ?? 0)
            : null,
        });
        assert.equal(rss.samples[0]?.receivedRows, 0);
        assert.equal(rss.samples.at(-1)?.receivedRows, expectedRows);
        if (process.env.PERF_GC_ON_SIGUSR2 === '1' && repeat < repeats) {
          process.kill(child.pid, 'SIGUSR2');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      assert(result);
      assert.equal(result.outcome, 'complete');
      assert.equal(result.status, 200);
      assert.equal(result.csvDataRows, expectedRows);
      assert.equal(result.crlfRecords, expectedRows + 1);
      assert(result.bytes > 0);
      assert(result.requestId);
      assert.match(result.contentType ?? '', /^text\/csv;\s*charset=utf-8$/i);
      assert.match(result.attachment ?? '', /attachment;\s*filename=/i);
      assert.equal(result.hasUtf8Bom, true);
      assert.equal(result.hasContentLength, false);
      const trace = rssTraces.at(-1);
      assert(trace);
      let completionEvent = readApiExportEvents().find(
        (event) => event.requestId === result.requestId,
      );
      const logWaitStarted = performance.now();
      while (!completionEvent && performance.now() - logWaitStarted < 2000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        completionEvent = readApiExportEvents().find(
          (event) => event.requestId === result.requestId,
        );
      }
      assert(
        completionEvent,
        'same-request API completion event was not logged',
      );
      assert.equal(completionEvent.rows, expectedRows);
      observations.push({
        name: 'isolated-rss-sample',
        scenario,
        audience: RSS_AUDIENCE,
        tenantCode: RSS_TENANT_CODE,
        round: RSS_SAMPLE_ROUND,
        apiProcessFreshForThisSample: true,
        apiPid: child.pid,
        warmupRequestsInThisProcess: 0,
        expectedRows,
        request: result,
        serverCompletion: completionEvent,
        sampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
        sampleCount: trace.rss.length,
        baseline: trace.rss[0] ?? null,
        firstAfterStart: trace.rss[1] ?? null,
        finalSample: trace.rss.at(-1) ?? null,
        repeatPeaks: rssTraces.map((item) => ({
          round: item.round,
          startBytes: item.startBytes,
          peakBytes: item.peakBytes,
          deltaBytes: item.deltaBytes,
        })),
        rssTrace: trace,
        ...(process.env.PERF_GC_ON_SIGUSR2 === '1' && child.pid
          ? await sampleRssAfterGc(child.pid, () => receivedRows)
          : {}),
      });
    } else if (!IDLE_DIAGNOSTIC_ONLY) {
      for (const scenario of fastCases) {
        assert(scenario.identity);
        const fixture = tenantRows.get(scenario.tenantCode);
        assert(fixture && origin);
        for (let warmup = 0; warmup < 2; warmup += 1) {
          const result = await queryExport(
            origin,
            fixture.id,
            scenario.audience,
            scenario.identity,
            () => undefined,
            { attempt: 'warmup', round: warmup + 1 },
          );
          results.push({
            ...result,
            scenario: `${scenario.audience}-${scenario.tenantCode}`,
          });
          assert.equal(result.outcome, 'complete');
          assert.equal(result.status, 200);
          assert.equal(
            result.csvDataRows,
            scenario.tenantCode === 'PORTALBIG'
              ? expectedPortalBigExportRows
              : EXPECTED_FIXTURE_ROWS[scenario.tenantCode],
          );
        }
      }
      for (let round = 1; round <= ROUNDS; round += 1) {
        const order = round % 2 === 1 ? fastCases : [...fastCases].reverse();
        for (const scenario of order) {
          assert(scenario.identity);
          const fixture = tenantRows.get(scenario.tenantCode);
          assert(fixture && origin && child?.pid);
          let receivedRows = 0;
          const rss = startRssSampler(child.pid, () => receivedRows);
          const result = await queryExport(
            origin,
            fixture.id,
            scenario.audience,
            scenario.identity,
            (_bytes, records) => {
              receivedRows = Math.max(0, records - 1);
            },
            { attempt: 'measured', round },
          );
          rss.stop();
          const serverSamples = rss.samples;
          rssRows.push(...serverSamples);
          const bytes = serverSamples.map((sample) => sample.rssBytes);
          results.push({
            ...result,
            scenario: `${scenario.audience}-${scenario.tenantCode}`,
            round,
          });
          rssTraces.push({
            scenario: `${scenario.audience}-${scenario.tenantCode}`,
            round,
            rss: serverSamples,
            startBytes: bytes[0] ?? null,
            peakBytes: bytes.length ? Math.max(...bytes) : null,
            deltaBytes: bytes.length
              ? Math.max(...bytes) - (bytes[0] ?? 0)
              : null,
          });
          assert.equal(
            result.outcome,
            'complete',
            `${scenario.tenantCode} run ${round} did not complete`,
          );
          assert.equal(
            result.status,
            200,
            `${scenario.tenantCode} run ${round} HTTP status`,
          );
          assert.equal(
            result.csvDataRows,
            EXPECTED_FIXTURE_ROWS[scenario.tenantCode],
            `${scenario.tenantCode} run ${round} row count`,
          );
          assert.match(
            result.contentType ?? '',
            /^text\/csv;\s*charset=utf-8$/i,
          );
          assert.match(result.attachment ?? '', /attachment;\s*filename=/i);
          assert.equal(
            result.hasUtf8Bom,
            true,
            `${scenario.tenantCode} run ${round} CSV BOM`,
          );
          assert.equal(
            result.hasContentLength,
            false,
            'streamed CSV must omit Content-Length',
          );
        }
      }
    }

    if (INCLUDE_SLOW && !IDLE_DIAGNOSTIC_ONLY) {
      assert(identities.portalBig && identities.admin && origin && child?.pid);
      const big = tenantRows.get('PORTALBIG');
      assert(big);
      const apiOrigin = origin;
      const portalBig = identities.portalBig;
      // A 20 KiB/s reader should fill the socket backpressure path; abort while the first fetch batch is still in flight.
      let bytesAtAbort = 0;
      const abortRss = startRssSampler(child.pid, () => bytesAtAbort);
      const aborted = await queryExport(
        apiOrigin,
        big.id,
        'portal',
        portalBig,
        (bytes) => {
          bytesAtAbort = bytes;
        },
        {
          rateBytesPerSecond: 20 * 1024,
          abortAfterBytes: 256 * 1024,
          maxDurationMs: 45_000,
        },
      );
      abortRss.stop();
      rssRows.push(...abortRss.samples);
      results.push({
        ...aborted,
        scenario: 'portal-backpressure-client-abort',
        round: 1,
      });
      assert.equal(aborted.outcome, 'client-abort');

      // Hold response reads completely until this request's server completion
      // and pool cleanup prove a continuous idle-in-transaction timeout.
      const idleDiagnostic = await observeIdleTimeout(
        apiOrigin,
        big.id,
        portalBig,
        owner,
        readApiExportEvents,
        3000,
        90_000,
        45_000,
        'database_error',
        [],
        true,
      );
      const idle = idleDiagnostic.result;
      assert(idle, 'idle-timeout client did not settle after unthrottle');
      results.push({
        ...idle,
        scenario: 'portal-idle-transaction-timeout',
        round: 1,
      });
      const idleObservation = {
        measurementClass: 'formal-export-slow-client',
        throttleBytesPerSecond: null,
        holdUntilServerCompletion: true,
        unthrottleAfterServerCompletionAndPoolCleanup: true,
        request: idle,
        serverCompletion: idleDiagnostic.serverCompletion,
        serverCompletionError: idleDiagnostic.serverCompletionError,
        pgActivityEachSecond: idleDiagnostic.activity,
        pgActivityErrors: idleDiagnostic.activityErrors,
        pgAtServerCompletion: idleDiagnostic.pgAtServerCompletion,
        afterServerCompletion: idleDiagnostic.afterServerCompletion,
        unthrottleElapsedMs: idleDiagnostic.unthrottleElapsedMs,
        afterRequest: idleDiagnostic.afterRequest,
      };
      observations.push(idleObservation);
      process.stdout.write(
        `${JSON.stringify({ event: 'idle-timeout-observation', ...idleObservation })}\n`,
      );
      assert.equal(idle.outcome, 'premature-close');
      assert(idle.elapsedMs >= 20_000 && idle.elapsedMs < 90_000);
      assert(idle.requestId, 'idle-timeout request has no request ID');
      const idleCompletion = idleDiagnostic.serverCompletion;
      assert.equal(idleCompletion?.result, 'database_error');
      assert(idleCompletion, 'server completion event was not observed');
      assert(
        idleDiagnostic.serverPoolCleanBeforeUnthrottle,
        'export pool was not clean before slow-client reads were released',
      );
      assert(
        idleDiagnostic.continuousIdleMsAtServerCompletion !== null &&
          idleDiagnostic.continuousIdleMsAtServerCompletion >= 25_000,
        'server export completion did not follow at least 25 seconds of continuous idle-in-transaction',
      );
      assert(
        Math.max(
          ...idleDiagnostic.activity.map(
            (sample) => sample.request.idleInTransaction,
          ),
        ) >= 1,
        'slow-client observation never saw its export transaction held idle',
      );
      assert.equal(
        idleDiagnostic.afterRequest.idleInTransaction,
        0,
        'export pool retained an idle transaction after slow-client failure',
      );
      assert.equal(
        idleDiagnostic.afterRequest.activeOrWaiting,
        0,
        'export pool retained active work after slow-client failure',
      );
      assert.equal(
        idleDiagnostic.afterRequest.cancelConnections,
        0,
        'cancel control connection remained after idle timeout',
      );
      observations.push({
        name: 'export-pool-slow-client-activity',
        applicationName: 'fsbilling-api-export',
        duringRequest: idleDiagnostic.activity,
        requestElapsedMs: idle.elapsedMs,
        requestId: idle.requestId,
        serverCompletion: idleCompletion,
        afterRequest: idleDiagnostic.afterRequest,
      });

      // A successful same-tenant request proves the failed transfer released its tenant admission slot.
      const reuse = await queryExport(
        apiOrigin,
        big.id,
        'portal',
        portalBig,
        () => undefined,
        { attempt: 'diagnostic', round: 1, maxDurationMs: 30_000 },
      );
      results.push({
        ...reuse,
        scenario: 'same-tenant-retry-after-idle-timeout',
        round: 1,
      });
      assert.equal(reuse.outcome, 'complete');
      assert.equal(reuse.csvDataRows, expectedPortalBigExportRows);
      const reuseCleanup = await waitForExportCleanup(owner);
      assert.equal(reuseCleanup.idleInTransaction, 0);
      assert.equal(reuseCleanup.activeOrWaiting, 0);
      assert.equal(reuseCleanup.cancelConnections, 0);
    }

    if (IDLE_DIAGNOSTIC_ONLY) {
      assert(identities.portalBig && origin);
      const big = tenantRows.get('PORTALBIG');
      assert(big);
      const prefixSteps: ('fast' | 'abort')[] = [];
      const prefixRequests: ExportResult[] = [];
      if (DIAGNOSTIC_PREFIX === 'fast' || DIAGNOSTIC_PREFIX === 'fast-abort')
        prefixSteps.push('fast');
      if (DIAGNOSTIC_PREFIX === 'abort' || DIAGNOSTIC_PREFIX === 'fast-abort')
        prefixSteps.push('abort');
      for (const step of prefixSteps) {
        const prefixStarted = performance.now();
        const prefixResult: ExportResult =
          step === 'fast'
            ? await queryExport(
                origin,
                big.id,
                'portal',
                identities.portalBig,
                () => undefined,
                {
                  attempt: 'diagnostic',
                  round: 1,
                  maxDurationMs: 30_000,
                },
              )
            : await queryExport(
                origin,
                big.id,
                'portal',
                identities.portalBig,
                () => undefined,
                {
                  rateBytesPerSecond: 20 * 1024,
                  abortAfterBytes: 256 * 1024,
                  maxDurationMs: 45_000,
                  attempt: 'diagnostic',
                  round: 1,
                },
              );
        const prefixScenario = `diagnostic-prefix-${step}`;
        results.push({ ...prefixResult, scenario: prefixScenario, round: 1 });
        const matchingEvent = prefixResult.requestId
          ? (readApiExportEvents().find(
              (event) => event.requestId === prefixResult.requestId,
            ) ?? null)
          : null;
        prefixRequests.push(prefixResult);
        const deferAbortActivity = step === 'abort';
        const requestActivity =
          !deferAbortActivity && prefixResult.requestId
            ? await observeExportActivity(owner, prefixResult.requestId)
            : null;
        const allActivity = deferAbortActivity
          ? null
          : await observeExportActivity(owner);
        const prefixObservation = {
          event: 'diagnostic-prefix-step',
          sequence: DIAGNOSTIC_PREFIX,
          step,
          elapsedMs: Number((performance.now() - prefixStarted).toFixed(1)),
          request: prefixResult,
          activitySnapshotDeferredUntilNextRequest: deferAbortActivity,
          serverCompletionEvent: matchingEvent,
          serverCompletionLagAfterClientMs: matchingEvent
            ? Number(
                (matchingEvent.elapsedMs - prefixResult.elapsedMs).toFixed(1),
              )
            : null,
          requestBackendAtClientResult: requestActivity,
          allBackendsAtClientResult: allActivity,
        };
        observations.push(prefixObservation);
        process.stdout.write(`${JSON.stringify(prefixObservation)}\n`);
        assert.equal(
          prefixResult.outcome,
          step === 'fast' ? 'complete' : 'client-abort',
          `${prefixScenario} ended with an unexpected client outcome`,
        );
      }
      const idleDiagnostic = await observeIdleTimeout(
        origin,
        big.id,
        identities.portalBig,
        owner,
        readApiExportEvents,
        3000,
        90_000,
        45_000,
        'database_error',
        prefixRequests,
      );
      if (idleDiagnostic.result)
        results.push({
          ...idleDiagnostic.result,
          scenario: 'diagnostic-only-portal-idle-timeout',
          round: 1,
        });
      const observation = {
        measurementClass:
          DIAGNOSTIC_PREFIX === 'none'
            ? 'diagnostic-only-idle'
            : `diagnostic-only-prefix-${DIAGNOSTIC_PREFIX}`,
        diagnosticPrefix: DIAGNOSTIC_PREFIX,
        prefixSteps,
        priorRequests: prefixRequests.map((request) => ({
          requestId: request.requestId,
          outcome: request.outcome,
          elapsedMs: request.elapsedMs,
        })),
        sampleIntervalMs: 1000,
        rateBytesPerSecond: 3000,
        holdUntilServerCompletion: false,
        pacingBasis: {
          priorFirstResponseChunkBytes: 65_214,
          priorRateBytesPerSecond: 1000,
          priorClientTimeoutMs: 45_000,
          derivedChunkDrainMsAtCurrentRate: 21_738,
          currentRateBytesPerSecond: 3000,
        },
        clientDeadlineMs: 90_000,
        ...idleDiagnostic,
      };
      observations.push(observation);
      process.stdout.write(
        `${JSON.stringify({ event: 'idle-only-observation', ...observation })}\n`,
      );
      assert(idleDiagnostic.result, 'client did not settle after unthrottle');
      const diagnosticResult = idleDiagnostic.result;
      assert(diagnosticResult.requestId);
      assert(
        Math.max(
          ...idleDiagnostic.activity.map(
            (sample) => sample.request.idleInTransaction,
          ),
        ) >= 1,
      );
      assert.equal(idleDiagnostic.afterRequest.idleInTransaction, 0);
      assert.equal(idleDiagnostic.afterRequest.activeOrWaiting, 0);
      assert.equal(idleDiagnostic.afterRequest.cancelConnections, 0);
      if (idleDiagnostic.serverCompletion) {
        assert.equal(diagnosticResult.outcome, 'premature-close');
        assert.equal(idleDiagnostic.serverCompletion.result, 'database_error');
        assert(idleDiagnostic.serverPoolCleanBeforeUnthrottle);
      }
    }

    if (INCLUDE_CONCURRENCY) {
      assert(identities.admin && origin);
      const apiOrigin = origin;
      const adminIdentity = identities.admin;
      const distinct = TENANT_CODES.flatMap((code) => {
        const fixture = tenantRows.get(code);
        return fixture ? [fixture] : [];
      });
      assert.equal(distinct.length, 5);
      const backendSamples: number[] = [];
      const controlSamples: number[] = [];
      const requests = Promise.all(
        distinct.map(async (fixture) => {
          const result = await queryExport(
            apiOrigin,
            fixture.id,
            'admin',
            adminIdentity,
            () => undefined,
            {
              rateBytesPerSecond: 8 * 1024,
              abortAfterBytes: 128 * 1024,
              maxDurationMs: 30_000,
            },
          );
          results.push({
            ...result,
            scenario: `global-limit-${fixture.code}`,
            round: 1,
          });
          return result;
        }),
      );
      let settled = false;
      void requests.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      while (!settled) {
        const activity = await observeExportActivity(owner);
        backendSamples.push(activity.connections);
        controlSamples.push(activity.cancelConnections);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const globalResults = await requests;
      assert.equal(
        globalResults.filter((result) => result.status === 429).length,
        1,
        'fifth distinct export must hit the global four-slot limit',
      );
      assert.equal(
        globalResults.filter(
          (result) =>
            result.status === 200 && result.outcome === 'client-abort',
        ).length,
        4,
      );
      assert(backendSamples.length > 0);
      assert(
        Math.max(...backendSamples) <= 4,
        'export database pool exceeded four connections',
      );
      assert(
        Math.max(...backendSamples) >= 2,
        'concurrent run never demonstrated simultaneous export pool connections',
      );
      assert(
        Math.max(...controlSamples) <= 4,
        'more than four cancellation control connections were open concurrently',
      );
      const globalCleanup = await waitForExportCleanup(owner);
      assert.equal(globalCleanup.idleInTransaction, 0);
      assert.equal(globalCleanup.activeOrWaiting, 0);
      assert.equal(globalCleanup.cancelConnections, 0);
      observations.push({
        name: 'export-pool-global-concurrency',
        applicationName: 'fsbilling-api-export',
        connectionSamples: backendSamples,
        maxObservedConnections: Math.max(...backendSamples),
        cancellationConnectionSamples: controlSamples,
        maxObservedCancellationConnections: Math.max(...controlSamples),
        afterRun: globalCleanup,
      });

      const sameTenant = tenantRows.get('PORTALBIG');
      assert(sameTenant);
      let resolveFirstStatus: (status: number | null) => void = () => undefined;
      const firstStatus = new Promise<number | null>((resolve) => {
        resolveFirstStatus = resolve;
      });
      const first = queryExport(
        apiOrigin,
        sameTenant.id,
        'admin',
        adminIdentity,
        () => undefined,
        {
          rateBytesPerSecond: 8 * 1024,
          abortAfterBytes: 64 * 1024,
          maxDurationMs: 20_000,
          onStatus: resolveFirstStatus,
        },
      );
      assert.equal(
        await firstStatus,
        200,
        'first same-tenant export must acquire its slot',
      );
      const second = await queryExport(
        apiOrigin,
        sameTenant.id,
        'admin',
        adminIdentity,
        () => undefined,
        { maxDurationMs: 10_000 },
      );
      const firstResult = await first;
      assert.equal(firstResult.outcome, 'client-abort');
      assert.equal(
        second.status,
        429,
        'second export for the same tenant must hit the per-tenant limit',
      );
      results.push({
        ...firstResult,
        scenario: 'tenant-limit-first-export-aborted',
        round: 1,
      });
      results.push({
        ...second,
        scenario: 'tenant-limit-second-export-rejected',
        round: 1,
      });
      const recovered = await queryExport(
        apiOrigin,
        sameTenant.id,
        'admin',
        adminIdentity,
        () => undefined,
        { attempt: 'diagnostic', round: 1, maxDurationMs: 30_000 },
      );
      results.push({
        ...recovered,
        scenario: 'same-tenant-retry-after-abort',
        round: 1,
      });
      assert.equal(recovered.outcome, 'complete');
      const recoveredActivity = await waitForExportCleanup(owner);
      assert.equal(recoveredActivity.idleInTransaction, 0);
      assert.equal(recoveredActivity.activeOrWaiting, 0);
      assert.equal(recoveredActivity.cancelConnections, 0);
      observations.push({
        name: 'same-tenant-retry-after-abort',
        activity: recoveredActivity,
      });
    }

    if (INCLUDE_DEADLINE) {
      assert(identities.portal200k && origin);
      const tenant200k = tenantRows.get('EXPORT200K');
      assert(tenant200k);
      const portal200kSamples = results.filter(
        (result) =>
          result.scenario === 'portal-EXPORT200K' &&
          result.attempt === 'measured',
      );
      assert.equal(
        portal200kSamples.length,
        ROUNDS,
        'deadline throttle requires all measured portal-EXPORT200K samples from this API process',
      );
      assert(
        portal200kSamples.every((result) => result.outcome === 'complete'),
        'deadline throttle requires complete portal-EXPORT200K samples',
      );
      const measuredByteCounts = new Set(
        portal200kSamples.map((result) => result.bytes),
      );
      assert.equal(
        measuredByteCounts.size,
        1,
        'portal-EXPORT200K response byte counts varied across rounds; refusing to infer deadline throttle',
      );
      const measured200kBytes = portal200kSamples[0]?.bytes;
      assert(measured200kBytes && measured200kBytes > 0);
      const batches = 40;
      const targetSecondsPerBatch = 15;
      const rateBytesPerSecond = Math.floor(
        measured200kBytes / (batches * targetSecondsPerBatch),
      );
      assert(rateBytesPerSecond > 0);
      const projected200kClientMs = Math.ceil(
        (measured200kBytes / rateBytesPerSecond) * 1000,
      );
      assert(
        projected200kClientMs >= 600_000,
        `measured portal-EXPORT200K size predicts only ${projected200kClientMs}ms at the derived rate; refusing to claim a six-hundred-second paced transfer`,
      );
      deadlineRateBasis = {
        sourceScenario: 'portal-EXPORT200K',
        measuredRounds: portal200kSamples.length,
        measuredBytes: measured200kBytes,
        fetchBatchSizeRows: 5000,
        batches,
        targetSecondsPerBatch,
        rateBytesPerSecond,
        projected200kClientMs,
      };
      // Keep the client paced until the same request's server deadline event
      // and export-pool cleanup are both observed. Only then release pacing to
      // distinguish the server cutoff from a client-side timeout.
      const deadlineDiagnostic = await observeIdleTimeout(
        origin,
        tenant200k.id,
        identities.portal200k,
        owner,
        readApiExportEvents,
        rateBytesPerSecond,
        330_000,
        320_000,
        'deadline',
      );
      const deadline = deadlineDiagnostic.result;
      assert(deadline, 'deadline client did not settle after unthrottle');
      results.push({
        ...deadline,
        scenario: 'portal-total-deadline',
        round: 1,
      });
      assert.equal(
        deadline.outcome,
        'premature-close',
        'server did not terminate the slow export at its total deadline',
      );
      assert(deadline.requestId, 'total-deadline request has no request ID');
      assert(
        deadline.elapsedMs >= 295_000 && deadline.elapsedMs < 330_000,
        'client did not observe the five-minute server deadline within the expected window',
      );
      const deadlineCompletion = deadlineDiagnostic.serverCompletion;
      assert(
        deadlineCompletion,
        'server deadline completion event was not observed',
      );
      assert.equal(deadlineCompletion.result, 'deadline');
      assert(
        deadlineDiagnostic.serverPoolCleanBeforeUnthrottle,
        'export pool was not clean before deadline-client reads were released',
      );
      assert(
        deadlineCompletion.elapsedMs >= 295_000 &&
          deadlineCompletion.elapsedMs <= 320_000,
        'server completion event was not the expected five-minute deadline',
      );
      const deadlineCleanup = deadlineDiagnostic.afterRequest;
      assert.equal(deadlineCleanup.idleInTransaction, 0);
      assert.equal(deadlineCleanup.activeOrWaiting, 0);
      assert.equal(deadlineCleanup.cancelConnections, 0);
      const deadlineRetry = await queryExport(
        origin,
        tenant200k.id,
        'portal',
        identities.portal200k,
        () => undefined,
        { attempt: 'diagnostic', round: 1, maxDurationMs: 30_000 },
      );
      results.push({
        ...deadlineRetry,
        scenario: 'same-tenant-retry-after-deadline',
        round: 1,
      });
      assert.equal(deadlineRetry.outcome, 'complete');
      assert.equal(deadlineRetry.csvDataRows, 200_000);
      assert(deadlineRetry.requestId);
      const afterRetry = await waitForExportCleanup(owner);
      assert.equal(afterRetry.idleInTransaction, 0);
      assert.equal(afterRetry.activeOrWaiting, 0);
      assert.equal(afterRetry.cancelConnections, 0);
      observations.push({
        name: 'total-deadline-cleanup',
        requestId: deadline.requestId,
        throttleBytesPerSecond: rateBytesPerSecond,
        rateDerivedFromMeasuredPortalExport200K: deadlineRateBasis,
        unthrottleAfterServerCompletionAndPoolCleanup: true,
        serverCompletion: deadlineCompletion,
        pgActivityEachSecond: deadlineDiagnostic.activity,
        pgActivityErrors: deadlineDiagnostic.activityErrors,
        pgAtServerCompletion: deadlineDiagnostic.pgAtServerCompletion,
        afterServerCompletion: deadlineDiagnostic.afterServerCompletion,
        serverPoolCleanBeforeUnthrottle:
          deadlineDiagnostic.serverPoolCleanBeforeUnthrottle,
        unthrottleElapsedMs: deadlineDiagnostic.unthrottleElapsedMs,
        deadlineCleanup,
        afterRetry,
      });
    }
  } catch (error) {
    failure = errorText(error);
    if (error instanceof ApiStartupError) {
      apiStartupCleanup = error.cleanup;
      apiStartupCleanupError = error.cleanupError;
      apiStartupChildPid = error.childPid;
      apiStartupDiagnostics = error.diagnostics;
      apiStartupEvents = error.exportEvents;
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
    }
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
      const adminIds = created.adminIds;
      if (adminIds.length) {
        const adminId = adminIds[0] ?? '';
        try {
          created.auditIds = await readAuditIds(owner, adminId);
        } catch {
          cleanupErrors.push('auditIds');
        }
        await clean('auditRows', () =>
          deleteAuditRows(owner, adminId, created.auditIds),
        );
      }
      if (adminIds.length) {
        await clean('adminRows', async () => {
          const result = await owner.query(
            'delete from admins where id=any($1::uuid[])',
            [adminIds],
          );
          return result.rowCount ?? 0;
        });
      }
      if (created.portalAccountIds.length) {
        await clean('portalAccountRows', async () => {
          const result = await owner.query(
            'delete from portal_accounts where id=any($1::uuid[])',
            [created.portalAccountIds],
          );
          return result.rowCount ?? 0;
        });
      }
    }
    if (authConnected && created.sessionIds.length) {
      await clean('sessionRows', async () => {
        const result = await auth.query(
          'delete from auth.session where id=any($1::text[])',
          [created.sessionIds],
        );
        return result.rowCount ?? 0;
      });
    }
    if (ownerConnected && created.userIds.length) {
      await clean('userRows', async () => {
        const result = await owner.query(
          'delete from auth."user" where id=any($1::text[])',
          [created.userIds],
        );
        return result.rowCount ?? 0;
      });
    }
    await Promise.allSettled([
      owner.end(),
      auth.end(),
      ...(appConnected ? [appClient.end()] : []),
    ]);
  }

  const groups = [...new Set(results.map((result) => result.scenario))].map(
    (scenario) => ({
      scenario,
      ...summary(results.filter((result) => result.scenario === scenario)),
    }),
  );
  const hundredK = results.filter(
    (result) =>
      (result.scenario === 'admin-EXPORT100K' ||
        result.scenario === 'portal-EXPORT100K') &&
      result.attempt === 'measured',
  );
  const exportBudgetViolations = hundredK.filter(
    (result) => result.outcome !== 'complete' || result.elapsedMs >= 30_000,
  );
  const rssComparisons = (['admin', 'portal'] as const).map((audience) => {
    const sizes = [50_000, 100_000, 200_000];
    const points = sizes.map((rows) => {
      const code = `EXPORT${rows / 1000}K`;
      const traces = rssTraces.filter(
        (trace) => trace.scenario === `${audience}-${code}`,
      );
      const deltas = traces.flatMap((trace) =>
        trace.deltaBytes === null ? [] : [trace.deltaBytes],
      );
      const peaks = traces.flatMap((trace) =>
        trace.peakBytes === null ? [] : [trace.peakBytes],
      );
      return {
        rows,
        rounds: traces.length,
        medianRssDeltaBytes: deltas.length ? summaryNumberMedian(deltas) : null,
        medianPeakRssBytes: peaks.length ? summaryNumberMedian(peaks) : null,
      };
    });
    return {
      audience,
      points,
      adjacentDeltaRatios: points.slice(1).map((point, index) => {
        const previous = points[index]?.medianRssDeltaBytes;
        return {
          fromRows: points[index]?.rows ?? null,
          toRows: point.rows,
          ratio:
            previous !== null &&
            previous !== undefined &&
            previous > 0 &&
            point.medianRssDeltaBytes !== null
              ? Number((point.medianRssDeltaBytes / previous).toFixed(2))
              : null,
        };
      }),
      interpretation:
        'raw and derived RSS observations for human review; no numeric nonlinearity threshold is asserted',
    };
  });
  const expectedDiagnosticResults = results.filter((result) => {
    if (result.attempt !== 'diagnostic') return false;
    if (
      IDLE_DIAGNOSTIC_ONLY &&
      result.scenario === 'diagnostic-only-portal-idle-timeout'
    )
      return true;
    if (
      IDLE_DIAGNOSTIC_ONLY &&
      result.scenario.startsWith('diagnostic-prefix-')
    ) {
      const prefixStep = result.scenario.slice('diagnostic-prefix-'.length);
      const expectedPrefixOutcome =
        prefixStep === 'abort' ? 'client-abort' : 'complete';
      return result.outcome === expectedPrefixOutcome;
    }
    const expectedOutcome: ExportResult['outcome'] | undefined =
      result.scenario === 'portal-backpressure-client-abort' ||
      result.scenario === 'tenant-limit-first-export-aborted'
        ? 'client-abort'
        : result.scenario === 'portal-idle-transaction-timeout' ||
            result.scenario === 'diagnostic-only-portal-idle-timeout' ||
            result.scenario === 'portal-total-deadline'
          ? 'premature-close'
          : result.scenario === 'tenant-limit-second-export-rejected'
            ? 'http-error'
            : result.scenario.startsWith('global-limit-')
              ? result.status === 429
                ? 'http-error'
                : result.status === 200
                  ? 'client-abort'
                  : undefined
              : undefined;
    return expectedOutcome !== undefined && result.outcome === expectedOutcome;
  });
  const expectedDiagnosticKeys = new Set(
    expectedDiagnosticResults.map(
      (result) =>
        `${result.scenario}:${result.round}:${result.requestId ?? ''}`,
    ),
  );
  const unexpectedResultFailures = results
    .filter((result) => result.outcome !== 'complete')
    .filter(
      (result) =>
        !expectedDiagnosticKeys.has(
          `${result.scenario}:${result.round}:${result.requestId ?? ''}`,
        ),
    );
  console.log(
    JSON.stringify(
      {
        runId,
        database: DATABASE,
        connectionIdentities,
        databaseProfile,
        fixtureCounts,
        expectedPortalBigExportRows,
        fixtureTenantIds: Object.fromEntries(
          [...tenantRows].map(([code, row]) => [code, row.id]),
        ),
        dateRange: { from: FROM, to: TO },
        transport:
          'real API child process, loopback HTTP POST, complete streaming body consumed unless explicitly throttled or aborted; CSV bytes/CRLF rows counted incrementally',
        warmupsPerFastScenario:
          IDLE_DIAGNOSTIC_ONLY || ISOLATED_RSS_SAMPLE ? 0 : 2,
        rounds: ROUNDS,
        measurementClass: IDLE_DIAGNOSTIC_ONLY
          ? DIAGNOSTIC_PREFIX === 'none'
            ? 'diagnostic-only-idle'
            : `diagnostic-only-prefix-${DIAGNOSTIC_PREFIX}`
          : ISOLATED_RSS_SAMPLE
            ? `isolated-rss-${RSS_AUDIENCE}-${RSS_TENANT_CODE}-r${RSS_SAMPLE_ROUND}`
            : FULL_ACCEPTANCE
              ? 'formal-full-acceptance'
              : 'partial-diagnostic',
        fullAcceptanceRequested: FULL_ACCEPTANCE,
        slowCasesEnabled: INCLUDE_SLOW,
        totalDeadlineCaseEnabled: INCLUDE_DEADLINE,
        deadlineRateBasis,
        concurrencyCasesEnabled: INCLUDE_CONCURRENCY,
        serverPid: child?.pid ?? null,
        apiStartupCleanup,
        apiStartupCleanupError,
        apiStartupChildPid,
        apiStartupDiagnostics,
        apiStartupEvents,
        rssSampler: ISOLATED_RSS_SAMPLE
          ? 'macOS ps -o rss=, API child only, 50 ms polling from pre-request baseline through immediate post-request sample; HTTP client process RSS excluded. Transient peaks shorter than 50 ms can be missed; sample count and elapsed time are recorded per process.'
          : 'macOS ps -o rss=, request-start baseline, 250 ms polling, immediate post-request sample; API child only, HTTP client process RSS excluded. Requests shorter than 250 ms can miss transient peaks.',
        rssRows,
        rssTraces,
        rssComparisons,
        rssMeasurementMethod: {
          processPid: child?.pid ?? null,
          isolatedFreshApiProcess: ISOLATED_RSS_SAMPLE,
          apiFreshForThisRequest: ISOLATED_RSS_SAMPLE,
          warmupRequestsInProcess: ISOLATED_RSS_SAMPLE ? 0 : undefined,
          measuredRoundsPerDataset: ISOLATED_RSS_SAMPLE ? 1 : ROUNDS,
          sampleIntervalMs: RSS_SAMPLE_INTERVAL_MS,
          order: ISOLATED_RSS_SAMPLE
            ? 'one audience, fixture size, and round per fresh API process'
            : 'export sizes are interleaved; every other round reverses the order',
          tracesIncludeRequestStartPeakDelta: true,
        },
        identities: Object.fromEntries(
          Object.entries(identities).map(([key, value]) => [
            key,
            value
              ? {
                  profileId: value.profileId,
                  userId: value.userId,
                  sessionId: value.sessionId,
                }
              : null,
          ]),
        ),
        createdRows: created,
        cleanup,
        cleanupErrors,
        failures: [
          ...(failure ? [{ message: errorText(failure) }] : []),
          ...unexpectedResultFailures.map((result) => ({ ...result })),
        ],
        diagnosticOutcomes: expectedDiagnosticResults.map((result) => ({
          ...result,
          expectedByScenario: true,
        })),
        results,
        summaries: groups,
        observations,
        exportBudget: {
          rowCount: 100_000,
          thresholdMs: 30_000,
          requests: hundredK.length,
          violations: exportBudgetViolations,
        },
        evidenceCaptureCommand: ISOLATED_RSS_SAMPLE
          ? `cd apps/api && PERF_TARGET_DATABASE=${DATABASE} PERF_RSS_ISOLATED=1 PERF_RSS_TENANT=${RSS_TENANT_CODE} PERF_RSS_AUDIENCE=${RSS_AUDIENCE} PERF_RSS_ROUND=${RSS_SAMPLE_ROUND} PERF_ROUNDS=1 node --env-file-if-exists=../../.env --import tsx scripts/portal-export-perf.ts`
          : IDLE_DIAGNOSTIC_ONLY
            ? `cd apps/api && mkdir -p ${evidenceDirectory} && set -o pipefail && PERF_TARGET_DATABASE=${DATABASE} PERF_DIAGNOSTIC_IDLE_ONLY=1 PERF_DIAGNOSTIC_PREFIX=${DIAGNOSTIC_PREFIX} PERF_ROUNDS=1 node --env-file-if-exists=../../.env --import tsx scripts/portal-export-perf.ts 2>&1 | tee ${evidenceDirectory}/export-diagnostic-prefix-${DIAGNOSTIC_PREFIX}.jsonl`
            : `cd apps/api && mkdir -p ${evidenceDirectory} && set -o pipefail && PERF_TARGET_DATABASE=${DATABASE} PERF_ACCEPTANCE=1 PERF_ROUNDS=${ROUNDS} PERF_SLOW=1 PERF_DEADLINE=1 PERF_CONCURRENCY=1 node --env-file-if-exists=../../.env --import tsx scripts/portal-export-perf.ts 2>&1 | tee ${formalEvidencePath}`,
      },
      null,
      2,
    ),
  );
  if (
    failure ||
    cleanupErrors.length ||
    exportBudgetViolations.length ||
    unexpectedResultFailures.length
  )
    process.exitCode = 1;
}

await main();
