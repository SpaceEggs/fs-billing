import type { EventEmitter } from 'node:events';
import type { QueryResultRow } from 'pg';
import { CSV_BOM, CSV_EOL, csvRecord } from '@fs-billing/rating';
import { ApiFailure } from '../errors.js';
import { ExportSlots, exportSlots } from './slots.js';

const FETCH_SIZE = 5000;
const EXPORT_TIMEOUT_MS = 5 * 60 * 1000;
const STATEMENT_TIMEOUT = "SET LOCAL statement_timeout = '30s'";
const IDLE_TIMEOUT = "SET LOCAL idle_in_transaction_session_timeout = '30s'";
const CURSOR_NAME = 'cdr_export';

type EventMethods = Pick<
  EventEmitter,
  'on' | 'removeListener' | 'listenerCount'
>;
type ExportResponse = EventMethods & {
  readonly headersSent: boolean;
  readonly socket: EventMethods | null;
  write(chunk: string): boolean;
  writeHead(statusCode: number): unknown;
  setHeader(name: string, value: number | string | readonly string[]): unknown;
  removeHeader(name: string): unknown;
  end(): unknown;
  destroy(error?: Error): unknown;
};
type ExportSocket = EventMethods;

export interface ExportRequest {
  readonly id: string;
  readonly log: {
    info(fields: Record<string, unknown>, message: string): void;
  };
}

export interface ExportReply {
  readonly raw: ExportResponse;
  hijack(): unknown;
  getHeaders(): Record<string, number | string | string[] | undefined>;
}

export interface ExportPool<Row extends QueryResultRow> {
  connect(): Promise<ExportClient<Row>>;
}

export type ExportScope =
  | { readonly kind: 'tenant'; readonly tenantId: string }
  | { readonly kind: 'admin' };

export interface ExportCursor {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface PreparedExport {
  readonly filename: string;
}

export interface ExportClient<Row extends QueryResultRow> extends EventMethods {
  query(query: 'SELECT pg_backend_pid() AS pid'): Promise<{
    readonly rows: { readonly pid: number }[];
  }>;
  query(
    query: string | { readonly text: string; readonly values?: unknown[] },
    values?: unknown[],
  ): Promise<{ readonly rows: Row[] }>;
  release(error?: Error | boolean): void;
  readonly connection: {
    readonly stream: {
      readonly destroyed: boolean;
      destroy(error?: Error): unknown;
    };
  };
}

export interface StreamCsvInput<Row extends QueryResultRow> {
  readonly request: ExportRequest;
  readonly reply: ExportReply;
  readonly pool: ExportPool<Row>;
  readonly admissionTenantId: string;
  readonly cancelBackend: (backendPid: number) => Promise<boolean>;
  readonly scope: ExportScope;
  readonly prepare: (signal: AbortSignal) => Promise<PreparedExport>;
  readonly cursor: ExportCursor;
  readonly headers: readonly string[];
  readonly rowToCells: (row: Row) => readonly string[];
}

type AbortKind =
  'client_closed' | 'database_error' | 'deadline' | 'response_error';

class ExportAbortError extends Error {
  constructor(
    readonly kind: AbortKind,
    cause?: unknown,
  ) {
    super(
      `CSV export aborted: ${kind}`,
      cause === undefined ? undefined : { cause },
    );
  }
}

type ExportResult =
  | 'success'
  | 'rate_limited'
  | 'preflight_error'
  | 'database_error'
  | 'client_closed'
  | 'response_error'
  | 'deadline';

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('CSV export was interrupted');
}

function safeFilename(filename: string): string {
  const normalized = filename.replace(/[^A-Za-z0-9._-]/g, '_');
  return normalized.length > 0 ? normalized : 'export.csv';
}

function serializedRows<Row extends QueryResultRow>(
  rows: readonly Row[],
  rowToCells: (row: Row) => readonly string[],
): string {
  return rows.map((row) => `${csvRecord(rowToCells(row))}${CSV_EOL}`).join('');
}

function waitForDrain(
  response: ExportResponse,
  signal: AbortSignal,
): { readonly promise: Promise<void>; readonly cancel: () => void } {
  let settled = false;
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = () => {
    response.removeListener('drain', onDrain);
    signal.removeEventListener('abort', onAbort);
  };
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const onDrain = () => finish(() => resolvePromise?.());
  const onAbort = () => finish(() => rejectPromise?.(abortReason(signal)));

  response.on('drain', onDrain);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return { promise, cancel: cleanup };
}

function waitForFinish(
  response: ExportResponse,
  signal: AbortSignal,
): { readonly promise: Promise<void>; readonly cancel: () => void } {
  let settled = false;
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  const cleanup = () => {
    response.removeListener('finish', onFinish);
    signal.removeEventListener('abort', onAbort);
  };
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    cleanup();
    callback();
  };
  const onFinish = () => finish(() => resolvePromise?.());
  const onAbort = () => finish(() => rejectPromise?.(abortReason(signal)));

  response.on('finish', onFinish);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  return { promise, cancel: cleanup };
}

function errorResult(error: unknown, stage: string): ExportResult {
  if (error instanceof ExportAbortError) return error.kind;
  if (stage === 'connect' || stage === 'query' || stage === 'commit')
    return 'database_error';
  return 'preflight_error';
}

/** Stream a parameterized cursor as CSV and own every resource until it ends. */
export async function streamCsv<Row extends QueryResultRow>(
  input: StreamCsvInput<Row>,
  slots: ExportSlots = exportSlots,
): Promise<void> {
  const startedAt = performance.now();
  const releaseSlot = slots.acquire(input.admissionTenantId);
  if (!releaseSlot) {
    input.request.log.info(
      {
        event: 'export.csv.completed',
        requestId: input.request.id,
        rows: 0,
        elapsedMs: Math.round(performance.now() - startedAt),
        result: 'rate_limited',
      },
      'CSV export rejected by admission limit',
    );
    throw new ApiFailure('RATE_LIMITED', 5);
  }

  const controller = new AbortController();
  let client: ExportClient<Row> | undefined;
  let committed = false;
  let responseStarted = false;
  let responseFinished = false;
  let clientConnectionBroken = false;
  let queryInFlight = false;
  let backendPid: number | undefined;
  let cancelPromise: Promise<void> | undefined;
  let rowsWritten = 0;
  let result: ExportResult = 'preflight_error';
  let stage = 'prepare';
  let activeDrain: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listenedSocket: { current: ExportSocket | null } = { current: null };
  let destroyingResponse = false;

  const query = async (
    text: string | { readonly text: string; readonly values?: unknown[] },
    values?: unknown[],
    allowAborted = false,
  ): Promise<{ readonly rows: Row[] }> => {
    if (!client) throw new Error('Export connection is not available');
    if (controller.signal.aborted && !allowAborted)
      throw abortReason(controller.signal);
    queryInFlight = true;
    try {
      const result = await client.query(text, values);
      if (controller.signal.aborted && !allowAborted)
        throw abortReason(controller.signal);
      return result;
    } finally {
      queryInFlight = false;
    }
  };

  const cancelActiveQuery = () => {
    if (!client || !queryInFlight || cancelPromise) return;
    const activeClient = client;
    const pid = backendPid;
    if (pid === undefined) {
      clientConnectionBroken = true;
      activeClient.connection.stream.destroy();
      return;
    }
    cancelPromise = Promise.resolve()
      .then(() => input.cancelBackend(pid))
      .then((cancelled) => {
        if (!cancelled)
          throw new Error('PostgreSQL did not cancel the export query');
      })
      .catch((error: unknown) => {
        clientConnectionBroken = true;
        activeClient.connection.stream.destroy(
          error instanceof Error
            ? error
            : new Error('Could not cancel the export query'),
        );
      });
  };

  const interrupt = (kind: AbortKind, cause?: unknown) => {
    if (controller.signal.aborted) return;
    controller.abort(new ExportAbortError(kind, cause));
    if (kind === 'database_error') clientConnectionBroken = true;
    if (queryInFlight) cancelActiveQuery();
    else if (kind === 'database_error' && client) {
      clientConnectionBroken = true;
      client.connection.stream.destroy();
    }
  };
  const onResponseClose = () => {
    if (!responseFinished && !destroyingResponse) interrupt('client_closed');
  };
  const onResponseError = (error: Error) => interrupt('response_error', error);
  const onResponseFinish = () => {
    responseFinished = true;
  };
  const onSocketClose = () => {
    if (!responseFinished && !destroyingResponse) interrupt('client_closed');
  };
  const onSocketError = (error: Error) => interrupt('response_error', error);
  const onClientError = (error: Error) => interrupt('database_error', error);
  const onClientEnd = () => interrupt('database_error');
  const attachSocket = () => {
    const socket = input.reply.raw.socket;
    if (!socket || socket === listenedSocket.current) return;
    if (listenedSocket.current) {
      listenedSocket.current.removeListener('close', onSocketClose);
      listenedSocket.current.removeListener('error', onSocketError);
    }
    listenedSocket.current = socket;
    socket.on('close', onSocketClose);
    socket.on('error', onSocketError);
  };
  const write = async (text: string, rowCount: number) => {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    const drain = waitForDrain(input.reply.raw, controller.signal);
    activeDrain = drain.cancel;
    let canContinue: boolean;
    try {
      canContinue = input.reply.raw.write(text);
      rowsWritten += rowCount;
    } catch (error) {
      drain.cancel();
      activeDrain = undefined;
      throw error;
    }
    if (canContinue) {
      drain.cancel();
      activeDrain = undefined;
      return;
    }
    try {
      await drain.promise;
    } finally {
      drain.cancel();
      activeDrain = undefined;
    }
  };

  try {
    input.reply.raw.on('close', onResponseClose);
    input.reply.raw.on('error', onResponseError);
    input.reply.raw.on('finish', onResponseFinish);
    attachSocket();
    timer = setTimeout(() => interrupt('deadline'), EXPORT_TIMEOUT_MS);

    if (controller.signal.aborted) throw abortReason(controller.signal);
    const prepared = await input.prepare(controller.signal);
    if (controller.signal.aborted) throw abortReason(controller.signal);

    stage = 'connect';
    client = await input.pool.connect();
    client.on('error', onClientError);
    client.on('end', onClientEnd);
    attachSocket();
    if (controller.signal.aborted) throw abortReason(controller.signal);

    stage = 'query';
    queryInFlight = true;
    try {
      const backend = await client.query('SELECT pg_backend_pid() AS pid');
      if (controller.signal.aborted) throw abortReason(controller.signal);
      backendPid = backend.rows[0]?.pid;
      if (backendPid === undefined)
        throw new Error('Could not identify export backend');
    } finally {
      queryInFlight = false;
    }
    await query('BEGIN');
    await query(STATEMENT_TIMEOUT);
    await query(IDLE_TIMEOUT);
    if (input.scope.kind === 'tenant') {
      await query(
        "SELECT set_config('app.scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
        [input.scope.tenantId],
      );
    } else {
      await query("SELECT set_config('app.scope', 'admin', true)");
    }
    await query({
      text: `DECLARE ${CURSOR_NAME} NO SCROLL CURSOR FOR ${input.cursor.text}`,
      values: [...input.cursor.values],
    });
    const firstBatch = await query(
      `FETCH FORWARD ${FETCH_SIZE} FROM ${CURSOR_NAME}`,
    );
    const firstBatchText = serializedRows(firstBatch.rows, input.rowToCells);

    input.reply.hijack();
    attachSocket();
    const response = input.reply.raw;
    for (const [name, value] of Object.entries(input.reply.getHeaders())) {
      if (value !== undefined && name.toLowerCase() !== 'content-length')
        response.setHeader(name, value);
    }
    response.removeHeader('content-length');
    response.setHeader('x-request-id', input.request.id);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeFilename(prepared.filename)}"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.writeHead(200);
    responseStarted = response.headersSent;

    stage = 'write';
    await write(
      `${CSV_BOM}${csvRecord(input.headers)}${CSV_EOL}${firstBatchText}`,
      firstBatch.rows.length,
    );

    let batch = firstBatch;
    while (batch.rows.length > 0) {
      stage = 'query';
      batch = await query(`FETCH FORWARD ${FETCH_SIZE} FROM ${CURSOR_NAME}`);
      if (batch.rows.length === 0) break;
      stage = 'write';
      await write(
        serializedRows(batch.rows, input.rowToCells),
        batch.rows.length,
      );
    }

    stage = 'commit';
    await query('COMMIT');
    committed = true;
    stage = 'end';
    const finish = waitForFinish(response, controller.signal);
    activeDrain = finish.cancel;
    try {
      response.end();
      await finish.promise;
    } finally {
      finish.cancel();
      activeDrain = undefined;
    }
    result = 'success';
  } catch (error) {
    const failure = controller.signal.aborted
      ? abortReason(controller.signal)
      : error;
    result = errorResult(failure, stage);
    if (responseStarted) {
      destroyingResponse = true;
      input.reply.raw.destroy();
      return;
    }
    throw failure;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    activeDrain?.();
    input.reply.raw.removeListener('close', onResponseClose);
    input.reply.raw.removeListener('error', onResponseError);
    input.reply.raw.removeListener('finish', onResponseFinish);
    if (listenedSocket.current) {
      listenedSocket.current.removeListener('close', onSocketClose);
      listenedSocket.current.removeListener('error', onSocketError);
    }

    if (client) {
      if (cancelPromise) await cancelPromise;
      client.removeListener('error', onClientError);
      client.removeListener('end', onClientEnd);
      let releaseError: Error | boolean | undefined = clientConnectionBroken
        ? true
        : undefined;
      if (!committed) {
        try {
          await query('ROLLBACK', undefined, true);
        } catch (rollbackError) {
          clientConnectionBroken = true;
          client.connection.stream.destroy();
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error('CSV export rollback failed');
        }
      }
      client.release(
        releaseError ?? (clientConnectionBroken ? true : undefined),
      );
    }

    releaseSlot();
    try {
      input.request.log.info(
        {
          event: 'export.csv.completed',
          requestId: input.request.id,
          rows: rowsWritten,
          elapsedMs: Math.round(performance.now() - startedAt),
          result,
        },
        'CSV export finished',
      );
    } catch {
      // Logging must not prevent releasing the export resources.
    }
  }
}
