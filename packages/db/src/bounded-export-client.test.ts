import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withBoundedExportClient } from './bounded-export-client.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TestClient extends pg.Client {
  readonly statements: string[] = [];
  readonly arguments: unknown[][] = [];
  readonly release = vi.fn<(error?: Error | boolean) => void>();
  run: (text: string) => Promise<unknown> = () => Promise.resolve({ rows: [] });

  constructor() {
    super();
    this.query = new Proxy(this.query.bind(this), {
      apply: (_target, receiver: unknown, args: unknown[]) => {
        expect(receiver).toBe(this);
        this.arguments.push(args);
        const argument: unknown = args[0];
        const text =
          typeof argument === 'string'
            ? argument
            : typeof argument === 'object' &&
                argument !== null &&
                'text' in argument &&
                typeof argument.text === 'string'
              ? argument.text
              : '';
        this.statements.push(text);
        if (text === 'SELECT pg_backend_pid() AS pid')
          return this.run(text).then(() => ({ rows: [{ pid: 42 }] }));
        return this.run(text);
      },
    });
  }
}

async function spinUntil(predicate: () => boolean) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Expected database operation did not start');
}

function lease(client: TestClient, controller = new AbortController()) {
  return {
    pool: { connect: () => Promise.resolve(client) },
    signal: controller.signal,
    cancelBackend: vi.fn<(_: number) => Promise<boolean>>(() =>
      Promise.resolve(true),
    ),
  };
}

afterEach(() => vi.useRealTimers());

describe('withBoundedExportClient', () => {
  it('bounds Drizzle implicit rollback after an ordinary transaction error', async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    client.run = (text) => {
      if (text === 'select broken') return Promise.reject(new Error('bad SQL'));
      if (text === 'rollback') return new Promise(() => undefined);
      return Promise.resolve({ rows: [] });
    };
    const pending = withBoundedExportClient(lease(client), (connection) =>
      drizzle(connection).transaction((tx) => tx.execute(sql`select broken`)),
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await spinUntil(() => client.statements.includes('rollback'));
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(client.connection.stream.destroyed).toBe(true);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits for delayed control before Drizzle rollback and preserves a reusable client', async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    const controller = new AbortController();
    const original = deferred<unknown>();
    const cancellation = deferred<boolean>();
    const input = lease(client, controller);
    input.cancelBackend.mockImplementation(() => cancellation.promise);
    client.run = (text) =>
      text === 'select count(*)'
        ? original.promise
        : Promise.resolve({ rows: [] });
    const pending = withBoundedExportClient(input, (connection) =>
      drizzle(connection).transaction((tx) => tx.execute(sql`select count(*)`)),
    );
    const reason = new Error('deadline');
    const rejected = expect(pending).rejects.toBe(reason);
    await spinUntil(() => client.statements.includes('select count(*)'));
    controller.abort(reason);
    original.reject(new Error('cancelled'));
    await spinUntil(() => input.cancelBackend.mock.calls.length === 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.statements).not.toContain('rollback');
    expect(client.release).not.toHaveBeenCalled();
    cancellation.resolve(true);
    await rejected;
    expect(client.statements.at(-1)).toBe('rollback');
    expect(client.connection.stream.destroyed).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('end')).toBe(0);
  });

  it('rolls back a BEGIN acknowledged after abort before releasing the lease', async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    const controller = new AbortController();
    const begin = deferred<unknown>();
    client.run = (text) =>
      text === 'begin' ? begin.promise : Promise.resolve({ rows: [] });
    const pending = withBoundedExportClient(
      lease(client, controller),
      (connection) =>
        drizzle(connection).transaction((tx) => tx.execute(sql`select 1`)),
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await spinUntil(() => client.statements.includes('begin'));
    controller.abort(new Error('deadline during begin'));
    begin.resolve({ rows: [] });
    await rejected;

    expect(client.statements.at(-1)?.toLowerCase()).toBe('rollback');
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['success', 'pending', 'failure', 'rejection'] as const)(
    'discards a silent original operation when control is %s',
    async (controlResult) => {
      vi.useFakeTimers();
      const client = new TestClient();
      const controller = new AbortController();
      const input = lease(client, controller);
      input.cancelBackend.mockImplementation(() => {
        if (controlResult === 'pending') return new Promise(() => undefined);
        if (controlResult === 'rejection')
          return Promise.reject(new Error('no control'));
        return Promise.resolve(controlResult === 'success');
      });
      client.run = (text) =>
        text === 'select silent'
          ? new Promise(() => undefined)
          : Promise.resolve({ rows: [] });
      const reason = new Error('deadline');
      const pending = withBoundedExportClient(input, async (connection) => {
        try {
          await connection.query('select silent');
        } finally {
          await connection.query({ text: 'ROLLBACK;' });
        }
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      await spinUntil(() => client.statements.includes('select silent'));
      controller.abort(reason);
      await vi.advanceTimersByTimeAsync(
        controlResult === 'pending' ? 8_000 : 2_000,
      );
      await rejected;
      expect(client.connection.stream.destroyed).toBe(true);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(client.statements).not.toContain('ROLLBACK;');
      expect(input.cancelBackend).toHaveBeenCalledExactlyOnceWith(42);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('destroys a silent PID lookup before backend identity is known', async () => {
    const client = new TestClient();
    const controller = new AbortController();
    const input = lease(client, controller);
    client.run = () => new Promise(() => undefined);
    const use = vi.fn(() => Promise.resolve());
    const pending = withBoundedExportClient(input, use);
    const reason = new Error('client closed');
    const rejected = expect(pending).rejects.toBe(reason);
    await spinUntil(() => client.statements.length === 1);
    controller.abort(reason);
    await rejected;
    expect(use).not.toHaveBeenCalled();
    expect(input.cancelBackend).not.toHaveBeenCalled();
    expect(client.connection.stream.destroyed).toBe(true);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it('keeps cleanup bounded when abort arrives during rollback without cancelling cleanup', async () => {
    vi.useFakeTimers();
    const client = new TestClient();
    const controller = new AbortController();
    const input = lease(client, controller);
    client.run = (text) =>
      text === 'ROLLBACK'
        ? new Promise(() => undefined)
        : Promise.resolve({ rows: [] });
    const pending = withBoundedExportClient(input, async (connection) => {
      await connection.query('ROLLBACK');
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    await spinUntil(() => client.statements.includes('ROLLBACK'));
    controller.abort(new Error('deadline'));
    expect(input.cancelBackend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['false', 'rejection', 'pending'] as const)(
    'discards a settled original query when delayed control ends with %s',
    async (result) => {
      vi.useFakeTimers();
      const client = new TestClient();
      const controller = new AbortController();
      const input = lease(client, controller);
      const original = deferred<unknown>();
      const cancellation = deferred<boolean>();
      input.cancelBackend.mockImplementation(() => cancellation.promise);
      client.run = (text) =>
        text === 'select slow'
          ? original.promise
          : Promise.resolve({ rows: [] });
      const pending = withBoundedExportClient(input, async (connection) => {
        try {
          await connection.query('select slow');
        } finally {
          await connection.query('ROLLBACK');
        }
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      await spinUntil(() => client.statements.includes('select slow'));
      controller.abort(new Error('deadline'));
      original.reject(new Error('cancelled'));
      await spinUntil(() => input.cancelBackend.mock.calls.length === 1);
      if (result === 'false') cancellation.resolve(false);
      else if (result === 'rejection')
        cancellation.reject(new Error('control failed'));
      await vi.advanceTimersByTimeAsync(8_000);
      await rejected;
      expect(client.statements).not.toContain('ROLLBACK');
      expect(client.connection.stream.destroyed).toBe(true);
      expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('removes owned listeners after a stream was already closed', async () => {
    const client = new TestClient();
    client.connection.stream.destroy();
    await new Promise<void>((resolve) =>
      client.connection.stream.once('close', resolve),
    );
    const pending = withBoundedExportClient(
      lease(client),
      async (connection) => {
        connection.emit('end');
        await connection.query('select never');
      },
    );
    await expect(pending).rejects.toBeInstanceOf(Error);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    expect(client.listenerCount('error')).toBe(0);
    expect(client.listenerCount('end')).toBe(0);
    expect(client.connection.stream.listenerCount('close')).toBe(0);
  });

  it('forwards query configuration and restores the exact original descriptor', async () => {
    const client = new TestClient();
    const descriptor = Object.getOwnPropertyDescriptor(client, 'query');
    const config = {
      text: 'select $1',
      values: ['value'],
      rowMode: 'array',
      types: { getTypeParser: () => (value: string) => value },
    };
    await withBoundedExportClient(lease(client), async (connection) => {
      await connection.query(config);
    });
    expect(client.arguments.at(-1)?.[0]).toBe(config);
    expect(Object.getOwnPropertyDescriptor(client, 'query')).toEqual(
      descriptor,
    );
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});
