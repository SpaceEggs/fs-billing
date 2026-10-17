import type { ExtractTablesWithRelations } from 'drizzle-orm';
import {
  drizzle,
  NodePgSession,
  NodePgTransaction,
} from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, withAdmin, withSystem } from './client.js';
import { retryTransaction } from './retry.js';
import * as schema from './schema.js';

const pgError = (code: string) => Object.assign(new Error(code), { code });

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('idle pool errors', () => {
  it.each([
    '57P01',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'password=do-not-log-this',
  ])('keeps errors handled and logs only safe fields for %s', async (code) => {
    const logger = { error: vi.fn() };
    const { pool } = connect('postgres://user:secret@localhost/billing', {
      logger,
    });
    const client = new pg.Client();
    const failure = Object.assign(
      new Error('postgres://user:secret@localhost/billing'),
      { code, detail: 'password=do-not-log-this', client },
    );
    try {
      expect(() => pool.emit('error', failure, client)).not.toThrow();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        {
          event: 'database.idle_client_error',
          pool: 'database',
          code: code === 'password=do-not-log-this' ? 'unknown' : code,
        },
        'Database idle connection failed',
      );
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        'do-not-log-this',
      );
    } finally {
      await pool.end();
    }
  });

  it.each([
    'api.business',
    'api.auth',
    'worker.business',
    'worker.queue',
    'future-service.reporting',
  ] as const)(
    'identifies the %s pool without logging the error message',
    async (poolName) => {
      const logger = { error: vi.fn() };
      const { pool } = connect('postgres://user:secret@localhost/billing', {
        poolName,
        logger,
      });
      try {
        pool.emit('error', new Error('Connection terminated unexpectedly'));
        expect(logger.error).toHaveBeenCalledExactlyOnceWith(
          {
            event: 'database.idle_client_error',
            pool: poolName,
            code: 'CONNECTION_TERMINATED',
          },
          'Database idle connection failed',
        );
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
      } finally {
        await pool.end();
      }
    },
  );

  it('uses the supplied logger across a startup async gap', async () => {
    const logger = { error: vi.fn() };
    const { pool } = connect('postgres://user:secret@localhost/billing', {
      poolName: 'new-application.background',
      logger,
    });
    await Promise.resolve();
    try {
      expect(() =>
        pool.emit('error', new Error('password=secret'), new pg.Client()),
      ).not.toThrow();
      expect(logger.error).toHaveBeenCalledExactlyOnceWith(
        {
          event: 'database.idle_client_error',
          pool: 'new-application.background',
          code: 'unknown',
        },
        'Database idle connection failed',
      );
    } finally {
      await pool.end();
    }
  });
});

describe('transaction retry backoff', () => {
  it('uses injected full jitter with exponential bounds capped at 200 ms', async () => {
    const failure = pgError('40001');
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);
    const random = vi.fn<() => number>();
    for (const value of [0, 0.25, 0.5, 0.75, 0.99, 0.5, 0.25]) {
      random.mockReturnValueOnce(value);
    }
    const sleep = vi
      .fn<(milliseconds: number) => Promise<void>>()
      .mockResolvedValue();

    await expect(
      retryTransaction({ operation, attempts: 8, random, sleep }),
    ).rejects.toBe(failure);

    expect(operation).toHaveBeenCalledTimes(8);
    expect(random).toHaveBeenCalledTimes(7);
    expect(sleep.mock.calls).toEqual([
      [0],
      [5],
      [20],
      [60],
      [158.4],
      [100],
      [50],
    ]);
    const bounds = [10, 20, 40, 80, 160, 200, 200];
    for (const [index, bound] of bounds.entries()) {
      const delay = sleep.mock.calls[index]?.[0];
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(bound);
    }
  });

  it('retries a wrapped driver error and returns the committed result', async () => {
    const failure = new Error('query failed', { cause: pgError('40P01') });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue('committed');
    const random = vi.fn(() => 0.5);
    const sleep = vi
      .fn<(milliseconds: number) => Promise<void>>()
      .mockResolvedValue();

    await expect(
      retryTransaction({ operation, attempts: 3, random, sleep }),
    ).resolves.toBe('committed');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[5]]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it.each(['23505', 'FORBIDDEN'])(
    'does not retry or delay %s',
    async (code) => {
      const failure = pgError(code);
      const operation = vi
        .fn<() => Promise<never>>()
        .mockRejectedValue(failure);
      const random = vi.fn(() => 0.5);
      const sleep = vi.fn<(milliseconds: number) => Promise<void>>();

      await expect(
        retryTransaction({ operation, attempts: 8, random, sleep }),
      ).rejects.toBe(failure);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(random).not.toHaveBeenCalled();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it('does not delay a successful first attempt', async () => {
    const random = vi.fn(() => 0.5);
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>();
    await expect(
      retryTransaction({
        operation: () => Promise.resolve('committed'),
        attempts: 8,
        random,
        sleep,
      }),
    ).resolves.toBe('committed');
    expect(random).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});

function transactionHarness() {
  const pool = new pg.Pool();
  const db = drizzle(pool, { schema });
  const dialect = new PgDialect();
  const session = new NodePgSession(pool, dialect, undefined);
  const tx = new NodePgTransaction<
    typeof schema,
    ExtractTablesWithRelations<typeof schema>
  >(dialect, session, undefined);
  vi.spyOn(tx, 'execute').mockResolvedValue({
    rows: [],
    rowCount: 0,
    command: 'SELECT',
    oid: 0,
    fields: [],
  });
  const transaction = vi
    .spyOn(db, 'transaction')
    .mockImplementation((callback) => callback(tx));
  return { db, tx, transaction };
}

describe('outermost transaction retry budgets', () => {
  it.each([
    { scope: 'admin', isolation: 'default', attempts: 3, code: '40001' },
    { scope: 'system', isolation: 'default', attempts: 3, code: '40P01' },
    { scope: 'admin', isolation: 'serializable', attempts: 8, code: '40001' },
  ])(
    'exhausts $scope $isolation after $attempts attempts',
    async ({ scope, isolation, attempts, code }) => {
      vi.useFakeTimers();
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const { db, transaction } = transactionHarness();
      const failure = new Error('query failed', { cause: pgError(code) });
      const callback = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
      const result =
        scope === 'system'
          ? withSystem(db, callback)
          : isolation === 'serializable'
            ? withAdmin(db, callback, { isolationLevel: 'serializable' })
            : withAdmin(db, callback);
      const rejected = expect(result).rejects.toBe(failure);
      await vi.runAllTimersAsync();
      await rejected;
      expect(transaction).toHaveBeenCalledTimes(attempts);
      expect(callback).toHaveBeenCalledTimes(attempts);
      expect(Math.random).toHaveBeenCalledTimes(attempts - 1);
      for (const [, config] of transaction.mock.calls) {
        expect(config).toEqual(
          isolation === 'serializable'
            ? { isolationLevel: 'serializable' }
            : undefined,
        );
      }
    },
  );

  it('allows a SERIALIZABLE transaction to succeed beyond the default budget', async () => {
    vi.useFakeTimers();
    const { db, transaction } = transactionHarness();
    const callback = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(pgError('40001'))
      .mockRejectedValueOnce(pgError('40001'))
      .mockRejectedValueOnce(pgError('40001'))
      .mockResolvedValue('committed');
    const result = withAdmin(db, callback, { isolationLevel: 'serializable' });
    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe('committed');
    expect(transaction).toHaveBeenCalledTimes(4);
  });

  it.each([withAdmin, withSystem])(
    'never retries a nested transaction',
    async (run) => {
      const { tx } = transactionHarness();
      const transaction = vi
        .spyOn(tx, 'transaction')
        .mockImplementation((callback) => callback(tx));
      const failure = pgError('40001');
      const callback = vi.fn<() => Promise<never>>().mockRejectedValue(failure);
      const random = vi.spyOn(Math, 'random');
      await expect(run(tx, callback)).rejects.toBe(failure);
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(random).not.toHaveBeenCalled();
    },
  );

  it('rejects nested isolation requests before opening a savepoint', async () => {
    const { tx } = transactionHarness();
    const transaction = vi.spyOn(tx, 'transaction');
    const callback = vi.fn<() => Promise<void>>();
    await expect(
      withAdmin(tx, callback, { isolationLevel: 'serializable' }),
    ).rejects.toThrow(
      'Transaction isolation must be requested at the outermost layer',
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });
});
