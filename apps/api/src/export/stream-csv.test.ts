import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { expect, describe, it, vi } from 'vitest';
import type { QueryResultRow } from 'pg';
import { ApiFailure } from '../errors.js';
import { ExportSlots } from './slots.js';
import {
  streamCsv,
  type ExportClient,
  type ExportPool,
  type ExportReply,
  type ExportRequest,
  type StreamCsvInput,
} from './stream-csv.js';

interface TestRow extends QueryResultRow {
  readonly call_uuid: string;
}

type FailurePoint =
  'BEGIN' | 'DECLARE' | 'first_fetch' | 'second_fetch' | 'COMMIT' | 'ROLLBACK';

interface FakeClientOptions {
  readonly firstRows?: readonly TestRow[];
  readonly failAt?: FailurePoint;
  readonly pendingSecondFetch?: boolean;
  readonly pendingCommit?: boolean;
  readonly pendingQuery?: string;
  readonly failRollback?: boolean;
  readonly events?: string[];
}

class FakeSocket extends EventEmitter {}

class FakeConnectionStream extends EventEmitter {
  destroyed = false;

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
    return this;
  }
}

class FakeResponse extends EventEmitter {
  headersSent = false;
  readonly socket = new FakeSocket();
  readonly headers = new Map<string, number | string | readonly string[]>();
  readonly writes: string[] = [];
  readonly events: string[] = [];
  statusCode: number | undefined;
  ended = false;
  destroyed = false;
  writeResults: boolean[] = [];
  emitDrainDuringWrite = false;

  setHeader(name: string, value: number | string | readonly string[]) {
    this.headers.set(name.toLowerCase(), value);
  }

  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }

  writeHead(statusCode: number) {
    this.events.push('writeHead');
    this.statusCode = statusCode;
    this.headersSent = true;
    return this;
  }

  write(chunk: string): boolean {
    this.writes.push(chunk);
    this.events.push('write');
    const canContinue = this.writeResults.shift() ?? true;
    if (!canContinue && this.emitDrainDuringWrite) this.emit('drain');
    return canContinue;
  }

  end() {
    this.events.push('end');
    this.ended = true;
    this.emit('finish');
    return this;
  }

  destroy() {
    this.events.push('destroy');
    this.destroyed = true;
    this.emit('close');
    return this;
  }
}

class FakeClient extends EventEmitter implements ExportClient<TestRow> {
  readonly connection = { stream: new FakeConnectionStream() };
  readonly queries: {
    readonly text: string;
    readonly values: readonly unknown[];
  }[] = [];
  readonly events: string[];
  releaseCount = 0;
  releaseError: Error | boolean | undefined;
  fetchCount = 0;
  readonly backendPid = 48291;
  readonly cancelBackendPids: number[] = [];
  pendingQueryCount = 0;
  private pendingQueryFailure: ((error: Error) => void) | undefined;

  constructor(private readonly options: FakeClientOptions = {}) {
    super();
    this.events = options.events ?? [];
  }

  query(query: 'SELECT pg_backend_pid() AS pid'): Promise<{
    readonly rows: { readonly pid: number }[];
  }>;
  query(
    query: string | { readonly text: string; readonly values?: unknown[] },
    values?: unknown[],
  ): Promise<{ readonly rows: TestRow[] }>;
  async query(
    query: string | { readonly text: string; readonly values?: unknown[] },
    values?: unknown[],
  ): Promise<{ readonly rows: TestRow[] | { readonly pid: number }[] }> {
    const text = typeof query === 'string' ? query : query.text;
    const queryValues =
      typeof query === 'string' ? (values ?? []) : (query.values ?? []);
    this.queries.push({ text, values: queryValues });
    this.events.push(`query:${text}`);

    if (text === 'SELECT pg_backend_pid() AS pid')
      return { rows: [{ pid: this.backendPid }] };
    if (this.connection.stream.destroyed)
      throw new Error('Connection terminated unexpectedly');
    if (text === this.options.pendingQuery) {
      return this.waitForQueryResult();
    }
    if (this.options.failAt === text) throw new Error(`failed ${text}`);
    if (text.startsWith('DECLARE') && this.options.failAt === 'DECLARE')
      throw new Error('failed DECLARE');
    if (text.startsWith('FETCH')) {
      this.fetchCount += 1;
      if (this.fetchCount === 1 && this.options.failAt === 'first_fetch')
        throw new Error('failed first FETCH');
      if (this.fetchCount > 1 && this.options.failAt === 'second_fetch')
        throw new Error('failed second FETCH');
      if (this.fetchCount > 1 && this.options.pendingSecondFetch)
        return this.waitForQueryResult();
      return {
        rows: this.fetchCount === 1 ? [...(this.options.firstRows ?? [])] : [],
      };
    }
    if (text === 'COMMIT' && this.options.pendingCommit)
      return this.waitForQueryResult();
    if (text === 'ROLLBACK' && this.options.failRollback)
      throw new Error('failed ROLLBACK');
    return { rows: [] };
  }

  cancelActiveQuery() {
    this.pendingQueryFailure?.(
      new Error('canceling statement due to user request'),
    );
  }

  private waitForQueryResult(): Promise<{ readonly rows: TestRow[] }> {
    this.pendingQueryCount += 1;
    return new Promise((_resolve, reject) => {
      const settle = (error: Error) => {
        if (!this.pendingQueryFailure) return;
        this.pendingQueryFailure = undefined;
        this.connection.stream.removeListener('close', onClose);
        this.pendingQueryCount -= 1;
        reject(error);
      };
      const onClose = () =>
        settle(new Error('Connection terminated unexpectedly'));
      this.pendingQueryFailure = settle;
      this.connection.stream.once('close', onClose);
    });
  }

  release(error?: Error | boolean) {
    this.releaseCount += 1;
    this.releaseError = error;
    this.events.push('release');
    if (error) this.connection.stream.destroy();
  }
}

class FakePool implements ExportPool<TestRow> {
  connectCount = 0;

  constructor(
    readonly client: FakeClient,
    private readonly connectFailure?: Error,
  ) {}

  connect(): Promise<ExportClient<TestRow>> {
    this.connectCount += 1;
    if (this.connectFailure) return Promise.reject(this.connectFailure);
    return Promise.resolve(this.client);
  }
}

interface TestRequest extends ExportRequest {
  readonly logs: Record<string, unknown>[];
}

function makeRequest(): TestRequest {
  const logs: Record<string, unknown>[] = [];
  return {
    id: 'request-123',
    logs,
    log: {
      info(fields) {
        logs.push(fields);
      },
    },
  };
}

function makeInput(
  options: {
    readonly client?: FakeClient;
    readonly connectFailure?: Error;
    readonly response?: FakeResponse;
    readonly admissionTenantId?: string;
    readonly cancelBackend?: (backendPid: number) => Promise<boolean>;
    readonly scope?: StreamCsvInput<TestRow>['scope'];
    readonly prepare?: (
      signal: AbortSignal,
    ) => Promise<{ readonly filename: string }>;
    readonly firstRows?: readonly TestRow[];
  } = {},
) {
  const response = options.response ?? new FakeResponse();
  const client =
    options.client ??
    new FakeClient({
      firstRows: options.firstRows ?? [
        { call_uuid: 'uuid-1' } satisfies TestRow,
      ],
      events: response.events,
    });
  const pool = new FakePool(client, options.connectFailure);
  const request = makeRequest();
  let hijacked = false;
  const reply: ExportReply = {
    raw: response,
    hijack() {
      hijacked = true;
      response.events.push('hijack');
    },
    getHeaders() {
      return {
        'cache-control': 'no-store',
        'content-length': 321,
      };
    },
  };
  const input: StreamCsvInput<TestRow> = {
    request,
    reply,
    pool,
    admissionTenantId: options.admissionTenantId ?? 'tenant-a',
    cancelBackend:
      options.cancelBackend ??
      ((backendPid) => {
        client.cancelBackendPids.push(backendPid);
        client.cancelActiveQuery();
        return Promise.resolve(true);
      }),
    scope: options.scope ?? { kind: 'tenant', tenantId: 'tenant-a' },
    prepare:
      options.prepare ?? (() => Promise.resolve({ filename: 'cdrs_A.csv' })),
    cursor: {
      text: 'SELECT call_uuid FROM cdrs WHERE tenant_id = $1',
      values: ['tenant-a'],
    },
    headers: ['通话UUID'],
    rowToCells: (row) => [row.call_uuid],
  };
  return {
    input,
    response,
    client,
    pool,
    request,
    wasHijacked: () => hijacked,
  };
}

async function spinUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Expected export event did not occur');
}

function cancellablePrepare(
  resource: FakeClient,
  onSettled: () => void,
  cancelBackend: (backendPid: number) => Promise<boolean>,
): (signal: AbortSignal) => Promise<{ readonly filename: string }> {
  return async (signal) => {
    let transactionStarted = false;
    let backendPid: number | undefined;
    let cancelPromise: Promise<void> | undefined;
    let releaseError: Error | undefined;
    const cancel = () => {
      if (cancelPromise) return;
      if (backendPid === undefined) {
        resource.connection.stream.destroy();
        return;
      }
      const pid = backendPid;
      cancelPromise = Promise.resolve()
        .then(() => cancelBackend(pid))
        .then((cancelled) => {
          if (cancelled) resource.cancelActiveQuery();
          else {
            resource.connection.stream.destroy();
          }
        })
        .catch(() => {
          resource.connection.stream.destroy();
        });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) cancel();
      const backend = await resource.query('SELECT pg_backend_pid() AS pid');
      backendPid = backend.rows[0]?.pid;
      if (backendPid === undefined)
        throw new Error('Could not identify prepare backend');
      if (signal.aborted) cancel();
      await resource.query('BEGIN');
      transactionStarted = true;
      await resource.query("SET LOCAL statement_timeout = '30s'");
      await resource.query('AUDIT COUNT');
      await resource.query('COMMIT');
      transactionStarted = false;
      return { filename: 'cdrs_A.csv' };
    } catch (error) {
      releaseError =
        error instanceof Error ? error : new Error('Prepare failed');
      if (cancelPromise) await cancelPromise;
      if (transactionStarted) {
        try {
          await resource.query('ROLLBACK');
        } catch (rollbackError) {
          resource.connection.stream.destroy();
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error('Prepare rollback failed');
        }
      }
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
      if (cancelPromise) await cancelPromise;
      resource.release(
        releaseError ??
          (signal.aborted ? new Error('Prepare aborted') : undefined),
      );
      onSettled();
    }
  };
}

function expectClean(response: FakeResponse, client: FakeClient) {
  for (const event of ['drain', 'close', 'error', 'finish'])
    expect(response.listenerCount(event)).toBe(0);
  for (const event of ['close', 'error'])
    expect(response.socket.listenerCount(event)).toBe(0);
  for (const event of ['error', 'end'])
    expect(client.listenerCount(event)).toBe(0);
  expect(client.connection.stream.listenerCount('close')).toBe(0);
}

describe('streamCsv', () => {
  it('writes BOM and CRLF CSV, preserves response headers, and commits before ending', async () => {
    const response = new FakeResponse();
    const client = new FakeClient({
      firstRows: [{ call_uuid: 'uuid-1' }],
      events: response.events,
    });
    response.writeResults = [false];
    response.emitDrainDuringWrite = true;
    const test = makeInput({ client, response });

    await streamCsv(test.input, new ExportSlots());

    expect(test.wasHijacked()).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('request-123');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-type')).toBe(
      'text/csv; charset=utf-8',
    );
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="cdrs_A.csv"',
    );
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.has('content-length')).toBe(false);
    expect(response.writes).toEqual(['\uFEFF通话UUID\r\nuuid-1\r\n']);
    expect(response.ended).toBe(true);
    expect(response.destroyed).toBe(false);
    expect(
      response.events.findIndex((event) => event.startsWith('query:FETCH')),
    ).toBeLessThan(response.events.indexOf('hijack'));
    expect(response.events.indexOf('query:COMMIT')).toBeLessThan(
      response.events.indexOf('end'),
    );
    expect(client.releaseCount).toBe(1);
    expect(
      client.queries.find((query) => query.text.startsWith('DECLARE')),
    ).toEqual({
      text: 'DECLARE cdr_export NO SCROLL CURSOR FOR SELECT call_uuid FROM cdrs WHERE tenant_id = $1',
      values: ['tenant-a'],
    });
    expect(test.request.logs.at(-1)).toMatchObject({
      event: 'export.csv.completed',
      requestId: 'request-123',
      rows: 1,
      result: 'success',
    });
    expectClean(response, client);
  });

  it('returns the request id on the real HTTP CSV response and completion log', async () => {
    const records: Record<string, unknown>[] = [];
    const app = Fastify({
      genReqId: () => 'loopback-export-request',
      logger: {
        level: 'info',
        stream: {
          write(line) {
            records.push(JSON.parse(line) as Record<string, unknown>);
          },
        },
      },
    });
    const test = makeInput({ firstRows: [] });
    app.get('/export.csv', async (request, reply) => {
      await streamCsv({ ...test.input, request, reply }, new ExportSlots());
    });

    try {
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const response = await fetch(new URL('/export.csv', address));
      await response.text();

      const requestId = response.headers.get('x-request-id');
      const completion = records.find(
        (record) => record.event === 'export.csv.completed',
      );
      expect(requestId).toBeTruthy();
      expect(completion?.requestId).toBe(requestId);
      expect(response.headers.get('content-type')).toContain('text/csv');
    } finally {
      await app.close();
    }
  });

  it('aborts a response closed while waiting for drain and returns the connection', async () => {
    const response = new FakeResponse();
    response.writeResults = [false];
    const test = makeInput({ response });
    const pending = streamCsv(test.input, new ExportSlots());
    await spinUntil(() => response.writes.length === 1);

    response.emit('close');
    await pending;

    expect(response.destroyed).toBe(true);
    expect(response.ended).toBe(false);
    expect(
      test.client.queries.filter((query) => query.text === 'ROLLBACK'),
    ).toHaveLength(1);
    expect(test.client.releaseCount).toBe(1);
    expect(test.client.releaseError).toBeUndefined();
    expect(test.request.logs.at(-1)).toMatchObject({ result: 'client_closed' });
    expectClean(response, test.client);
  });

  it.each(['error', 'end'] as const)(
    'aborts a producer waiting for drain when the pg client emits %s',
    async (event) => {
      const response = new FakeResponse();
      response.writeResults = [false];
      const test = makeInput({ response });
      const pending = streamCsv(test.input, new ExportSlots());
      await spinUntil(() => response.writes.length === 1);

      if (event === 'error')
        test.client.emit('error', new Error('socket failed'));
      else test.client.emit('end');
      await pending;

      expect(response.destroyed).toBe(true);
      expect(response.ended).toBe(false);
      expect(
        test.client.queries.filter((query) => query.text === 'ROLLBACK'),
      ).toHaveLength(1);
      expect(test.client.releaseCount).toBe(1);
      expect(test.client.releaseError).toBeInstanceOf(Error);
      expect(test.request.logs.at(-1)).toMatchObject({
        result: 'database_error',
      });
      expectClean(response, test.client);
    },
  );

  it('uses the deadline to end a stalled response and rolls back', async () => {
    vi.useFakeTimers();
    try {
      const response = new FakeResponse();
      response.writeResults = [false];
      const test = makeInput({ response });
      const pending = streamCsv(test.input, new ExportSlots());
      await spinUntil(() => response.writes.length === 1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await pending;

      expect(response.destroyed).toBe(true);
      expect(response.ended).toBe(false);
      expect(
        test.client.queries.filter((query) => query.text === 'ROLLBACK'),
      ).toHaveLength(1);
      expect(test.client.releaseError).toBeUndefined();
      expect(test.request.logs.at(-1)).toMatchObject({ result: 'deadline' });
      expect(vi.getTimerCount()).toBe(0);
      expectClean(response, test.client);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases admission after an audit or filename preparation failure', async () => {
    const slots = new ExportSlots();
    const failed = makeInput({
      prepare: () => Promise.reject(new Error('audit transaction failed')),
    });

    await expect(streamCsv(failed.input, slots)).rejects.toThrow(
      'audit transaction failed',
    );

    expect(failed.pool.connectCount).toBe(0);
    expect(failed.wasHijacked()).toBe(false);
    expect(failed.response.destroyed).toBe(false);
    expect(failed.response.writes).toEqual([]);
    expect(failed.request.logs.at(-1)).toMatchObject({
      result: 'preflight_error',
    });

    const retry = makeInput({ firstRows: [] });
    await streamCsv(retry.input, slots);
    expect(retry.response.ended).toBe(true);
    expect(retry.client.releaseCount).toBe(1);
    expectClean(failed.response, failed.client);
    expectClean(retry.response, retry.client);
  });

  it.each(['client_close', 'deadline'] as const)(
    'cancels a live prepare query on %s and waits for its transaction cleanup',
    async (abortKind) => {
      if (abortKind === 'deadline') vi.useFakeTimers();
      try {
        const resource = new FakeClient({ pendingQuery: 'AUDIT COUNT' });
        let prepareSettled = false;
        let prepareListenerRemoved = false;
        const prepareCancelPids: number[] = [];
        const prepare = cancellablePrepare(
          resource,
          () => {
            prepareSettled = true;
            prepareListenerRemoved = true;
          },
          (backendPid) => {
            prepareCancelPids.push(backendPid);
            resource.cancelActiveQuery();
            return Promise.resolve(true);
          },
        );
        const response = new FakeResponse();
        const cursorClient = new FakeClient({ firstRows: [] });
        const test = makeInput({
          response,
          client: cursorClient,
          prepare,
        });
        const slots = new ExportSlots();
        const pending = streamCsv(test.input, slots);
        const rejected = expect(pending).rejects.toMatchObject({
          kind: abortKind === 'client_close' ? 'client_closed' : 'deadline',
        });
        await spinUntil(() => resource.pendingQueryCount === 1);

        if (abortKind === 'client_close') response.emit('close');
        else await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        await rejected;
        expect(prepareSettled).toBe(true);
        expect(prepareListenerRemoved).toBe(true);
        expect(prepareCancelPids).toEqual([resource.backendPid]);
        expect(resource.pendingQueryCount).toBe(0);
        expect(resource.connection.stream.destroyed).toBe(true);
        expect(resource.connection.stream.listenerCount('close')).toBe(0);
        expect(
          resource.queries.filter((query) => query.text === 'ROLLBACK'),
        ).toHaveLength(1);
        expect(resource.releaseCount).toBe(1);
        expect(resource.releaseError).toBeInstanceOf(Error);
        expect(test.pool.connectCount).toBe(0);
        expect(response.writes).toEqual([]);
        expect(response.destroyed).toBe(false);
        expect(test.request.logs.at(-1)).toMatchObject({
          result: abortKind === 'client_close' ? 'client_closed' : 'deadline',
        });
        expectClean(response, cursorClient);
        if (abortKind === 'deadline') expect(vi.getTimerCount()).toBe(0);
      } finally {
        if (abortKind === 'deadline') vi.useRealTimers();
      }
    },
  );

  it('cancels a pending FETCH on client close and rolls back before reusing the connection', async () => {
    const response = new FakeResponse();
    const client = new FakeClient({
      firstRows: [{ call_uuid: 'uuid-1' }],
      pendingSecondFetch: true,
    });
    const cancellationStarted = deferred<void>();
    const cancellationResult = deferred<boolean>();
    const test = makeInput({
      client,
      response,
      cancelBackend: (backendPid) => {
        client.cancelBackendPids.push(backendPid);
        cancellationStarted.resolve();
        return cancellationResult.promise.then((cancelled) => {
          if (cancelled) client.cancelActiveQuery();
          return cancelled;
        });
      },
    });
    const pending = streamCsv(test.input, new ExportSlots());
    await spinUntil(() => client.fetchCount === 2);

    response.emit('close');
    await cancellationStarted.promise;
    expect(client.pendingQueryCount).toBe(1);
    expect(client.releaseCount).toBe(0);
    expect(response.destroyed).toBe(false);
    cancellationResult.resolve(true);
    await pending;

    expect(response.destroyed).toBe(true);
    expect(response.ended).toBe(false);
    expect(client.cancelBackendPids).toEqual([client.backendPid]);
    expect(client.connection.stream.destroyed).toBe(false);
    expect(
      client.queries.filter((query) => query.text === 'ROLLBACK'),
    ).toHaveLength(1);
    expect(client.releaseError).toBeUndefined();
    expect(client.releaseCount).toBe(1);
    expectClean(response, client);
  });

  it('destroys the cursor connection if backend cancellation fails and still cleans up', async () => {
    const slots = new ExportSlots();
    const client = new FakeClient({
      firstRows: [{ call_uuid: 'uuid-1' }],
      pendingSecondFetch: true,
    });
    const test = makeInput({
      client,
      cancelBackend: (backendPid) => {
        client.cancelBackendPids.push(backendPid);
        return Promise.reject(new Error('cancel control timed out'));
      },
    });
    const pending = streamCsv(test.input, slots);
    await spinUntil(() => client.fetchCount === 2);

    test.response.emit('close');
    await pending;

    expect(client.cancelBackendPids).toEqual([client.backendPid]);
    expect(client.connection.stream.destroyed).toBe(true);
    expect(client.pendingQueryCount).toBe(0);
    expect(
      client.queries.filter((query) => query.text === 'ROLLBACK'),
    ).toHaveLength(1);
    expect(client.releaseError).toBeInstanceOf(Error);
    expect(client.releaseCount).toBe(1);
    expect(test.response.destroyed).toBe(true);
    expect(test.response.ended).toBe(false);
    expectClean(test.response, client);

    const retry = makeInput({ firstRows: [] });
    await streamCsv(retry.input, slots);
    expect(retry.response.ended).toBe(true);
    expect(retry.client.releaseCount).toBe(1);
    expectClean(retry.response, retry.client);
  });

  it('cancels a pending COMMIT on deadline and awaits the server response', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient({ firstRows: [], pendingCommit: true });
      const test = makeInput({ client });
      const pending = streamCsv(test.input, new ExportSlots());
      const completed = pending.then(
        () => 'completed',
        () => 'rejected',
      );
      await spinUntil(() => client.pendingQueryCount === 1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await pending;

      expect(await completed).toBe('completed');
      expect(client.cancelBackendPids).toEqual([client.backendPid]);
      expect(client.pendingQueryCount).toBe(0);
      expect(client.connection.stream.destroyed).toBe(false);
      expect(
        client.queries.filter((query) => query.text === 'ROLLBACK'),
      ).toHaveLength(1);
      expect(client.releaseError).toBeUndefined();
      expect(client.releaseCount).toBe(1);
      expect(test.response.destroyed).toBe(true);
      expect(test.response.ended).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expectClean(test.response, client);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { name: 'connect', connectFailure: true },
    { name: 'BEGIN', failAt: 'BEGIN' },
    { name: 'DECLARE', failAt: 'DECLARE' },
    { name: 'first FETCH', failAt: 'first_fetch' },
  ] as const)(
    'keeps connect, BEGIN, DECLARE, and first FETCH failures before the CSV response',
    async ({ name, connectFailure, failAt }) => {
      const client = new FakeClient(failAt ? { failAt } : {});
      const test = makeInput({
        client,
        ...(connectFailure
          ? { connectFailure: new Error(`${name} failed`) }
          : {}),
      });

      await expect(
        streamCsv(test.input, new ExportSlots()),
      ).rejects.toBeInstanceOf(Error);

      expect(test.wasHijacked()).toBe(false);
      expect(test.response.headersSent).toBe(false);
      expect(test.response.writes).toEqual([]);
      expect(test.response.destroyed).toBe(false);
      if (!connectFailure) {
        expect(
          client.queries.filter((query) => query.text === 'ROLLBACK'),
        ).toHaveLength(1);
        expect(client.releaseCount).toBe(1);
      }
      expectClean(test.response, client);
    },
  );

  it('destroys a partial CSV after a later FETCH or COMMIT failure', async () => {
    for (const failAt of ['second_fetch', 'COMMIT'] as const) {
      const client = new FakeClient({
        firstRows: [{ call_uuid: 'uuid-1' }],
        failAt,
      });
      const test = makeInput({ client });

      await streamCsv(test.input, new ExportSlots());

      expect(test.response.headersSent).toBe(true);
      expect(test.response.destroyed).toBe(true);
      expect(test.response.ended).toBe(false);
      expect(
        client.queries.filter((query) => query.text === 'ROLLBACK'),
      ).toHaveLength(1);
      expect(client.releaseCount).toBe(1);
      expectClean(test.response, client);
    }
  });

  it('destroys the client when rollback fails and releases the slot for a retry', async () => {
    const slots = new ExportSlots();
    const failedClient = new FakeClient({ failAt: 'first_fetch' });
    const failed = makeInput({ client: failedClient });
    await expect(streamCsv(failed.input, slots)).rejects.toBeInstanceOf(Error);
    expect(failed.response.destroyed).toBe(false);

    const rollbackFailure = new FakeClient({
      firstRows: [{ call_uuid: 'uuid-1' }],
      failAt: 'second_fetch',
      failRollback: true,
    });
    const broken = makeInput({ client: rollbackFailure });
    await streamCsv(broken.input, slots);

    expect(broken.response.destroyed).toBe(true);
    expect(
      rollbackFailure.queries.filter((query) => query.text === 'ROLLBACK'),
    ).toHaveLength(1);
    expect(rollbackFailure.connection.stream.destroyed).toBe(true);
    expect(rollbackFailure.releaseError).toBeInstanceOf(Error);
    expect(rollbackFailure.releaseCount).toBe(1);

    const retryClient = new FakeClient({ firstRows: [] });
    const retry = makeInput({ client: retryClient });
    await streamCsv(retry.input, slots);

    expect(retry.response.ended).toBe(true);
    expect(retryClient.releaseCount).toBe(1);
    expectClean(retry.response, retryClient);
  });

  it('keeps admin and portal admissions tenant-scoped and releases slots idempotently', async () => {
    const slots = new ExportSlots();
    const pendingPrepare = deferred<{ readonly filename: string }>();
    const first = makeInput({
      admissionTenantId: 'tenant-shared',
      scope: { kind: 'tenant', tenantId: 'tenant-shared' },
      prepare: () => pendingPrepare.promise,
    });
    const firstPending = streamCsv(first.input, slots);

    let adminPrepareCalls = 0;
    const competing = makeInput({
      admissionTenantId: 'tenant-shared',
      scope: { kind: 'admin' },
      prepare: () => {
        adminPrepareCalls += 1;
        return Promise.resolve({ filename: 'admin.csv' });
      },
    });
    await expect(streamCsv(competing.input, slots)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterSeconds: 5,
    });
    expect(adminPrepareCalls).toBe(0);
    expect(competing.response.writes).toEqual([]);
    expect(competing.wasHijacked()).toBe(false);

    pendingPrepare.resolve({ filename: 'portal.csv' });
    await firstPending;
    expect(first.response.ended).toBe(true);

    const release = slots.acquire('tenant-shared');
    if (!release) throw new Error('Expected the slot to be available');
    release();
    release();
    const availableAgain = slots.acquire('tenant-shared');
    if (!availableAgain)
      throw new Error('Expected idempotent release to free the slot');
    availableAgain();
  });

  it('allows four different admin tenant exports and rejects the fifth before prepare', async () => {
    const slots = new ExportSlots();
    const preparations = Array.from({ length: 4 }, () =>
      deferred<{ readonly filename: string }>(),
    );
    const active = preparations.map((preparation, index) => {
      const tenantId = `tenant-${index + 1}`;
      const test = makeInput({
        admissionTenantId: tenantId,
        scope: { kind: 'admin' },
        firstRows: [],
        prepare: () => preparation.promise,
      });
      return { test, preparation, pending: streamCsv(test.input, slots) };
    });
    let fifthPrepareCalls = 0;
    const fifth = makeInput({
      admissionTenantId: 'tenant-5',
      scope: { kind: 'admin' },
      prepare: () => {
        fifthPrepareCalls += 1;
        return Promise.resolve({ filename: 'fifth.csv' });
      },
    });
    await expect(streamCsv(fifth.input, slots)).rejects.toBeInstanceOf(
      ApiFailure,
    );
    expect(fifthPrepareCalls).toBe(0);
    expect(fifth.response.writes).toEqual([]);

    for (const entry of active)
      entry.preparation.resolve({ filename: 'admin.csv' });
    await Promise.all(active.map((entry) => entry.pending));
    for (const entry of active) {
      expect(entry.test.response.ended).toBe(true);
      expect(entry.test.client.releaseCount).toBe(1);
      expectClean(entry.test.response, entry.test.client);
    }
  });

  it('leaves no timeout or listeners across repeated success and failure cycles', async () => {
    vi.useFakeTimers();
    try {
      const slots = new ExportSlots();
      for (let i = 0; i < 10; i += 1) {
        const failed = i % 2 === 0;
        const client = failed
          ? new FakeClient({ firstRows: [], failAt: 'first_fetch' })
          : new FakeClient({ firstRows: [] });
        const test = makeInput({ client });
        if (failed)
          await expect(streamCsv(test.input, slots)).rejects.toBeInstanceOf(
            Error,
          );
        else await streamCsv(test.input, slots);
        expect(test.response.ended).toBe(!failed);
        expect(test.response.destroyed).toBe(false);
        expect(test.client.releaseCount).toBe(1);
        expectClean(test.response, test.client);
        expect(vi.getTimerCount()).toBe(0);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise)
        throw new Error('Deferred promise is not initialized');
      resolvePromise(value);
    },
  };
}
