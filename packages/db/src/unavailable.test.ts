import pg from 'pg';
import { connect } from './client.js';
import { expect, it, vi } from 'vitest';
import {
  DatabaseUnavailableError,
  normalizePgOperation,
} from './unavailable.js';

it.each([
  new Error('Connection terminated unexpectedly'),
  new Error('timeout exceeded when trying to connect'),
  new Error('Connection terminated due to connection timeout'),
  new Error('Client has encountered a connection error and is not queryable'),
  Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' }),
  Object.assign(new Error('read failed'), { code: 'ECONNRESET' }),
])(
  'normalizes pg transport rejection %s and preserves its cause',
  async (cause) => {
    const operation = normalizePgOperation(() => Promise.reject(cause));
    const error: unknown = await operation().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(DatabaseUnavailableError);
    expect(error).toHaveProperty('cause', cause);
  },
);

it('preserves arbitrary errors, SQLSTATEs, and existing typed errors', async () => {
  for (const cause of [
    new Error('arbitrary error'),
    Object.assign(new Error('serialization'), { code: '40001' }),
    Object.assign(new Error('deadlock'), { code: '40P01' }),
    new DatabaseUnavailableError(
      new Error('Connection terminated unexpectedly'),
    ),
  ]) {
    const operation = normalizePgOperation(() => Promise.reject(cause));
    await expect(operation()).rejects.toBe(cause);
  }
});

it('preserves callback receiver, successful values, and release function', () => {
  const cause = new Error('timeout exceeded when trying to connect');
  const receiver = { marker: 'receiver' };
  const client = { marker: 'client' };
  const release = () => undefined;
  const operation = normalizePgOperation(function (
    this: typeof receiver,
    callback: (
      error: Error | undefined,
      value: typeof client,
      done: typeof release,
    ) => void,
  ) {
    expect(this).toBe(receiver);
    callback.call(receiver, cause, client, release);
  });
  let called = false;
  operation.call(
    receiver,
    function (this: typeof receiver, error, value, done) {
      called = true;
      expect(this).toBe(receiver);
      expect(error).toBeInstanceOf(DatabaseUnavailableError);
      expect(error?.cause).toBe(cause);
      expect(value).toBe(client);
      expect(done).toBe(release);
    },
  );
  expect(called).toBe(true);
});

it('handles pg error events on checked-out clients without crashing', async () => {
  const connection = connect('postgresql://localhost/unused');
  const client = new pg.Client();
  connection.pool.emit('connect', client);
  try {
    expect(() =>
      client.emit('error', new Error('Connection terminated unexpectedly')),
    ).not.toThrow();
  } finally {
    await client.end();
    await connection.pool.end();
  }
});

it.each(['before', 'after'])(
  'preserves instrumentation installed %s a pooled client connects',
  async (timing) => {
    const connection = connect('postgresql://localhost/unused');
    const client = new pg.Client();
    if (timing === 'after') connection.pool.emit('connect', client);
    const query = vi.spyOn(pg.Client.prototype, 'query');
    if (timing === 'before') connection.pool.emit('connect', client);
    try {
      await client.end();
      await expect(client.query('select 1')).rejects.toMatchObject({
        name: 'DatabaseUnavailableError',
        cause: { message: 'Client was closed and is not queryable' },
      });
      expect(query.mock.calls).toEqual([['select 1']]);
      expect(query.mock.contexts).toEqual([client]);
    } finally {
      query.mockRestore();
      await connection.pool.end();
    }
  },
);

it('preserves existing client query instrumentation', async () => {
  const connection = connect('postgresql://localhost/unused');
  const client = new pg.Client();
  const query = vi.spyOn(client, 'query');
  connection.pool.emit('connect', client);
  try {
    await client.end();
    await expect(client.query('select 1')).rejects.toMatchObject({
      name: 'DatabaseUnavailableError',
      cause: { message: 'Client was closed and is not queryable' },
    });
    expect(query.mock.calls).toEqual([['select 1']]);
    expect(query.mock.contexts).toEqual([client]);
  } finally {
    query.mockRestore();
    await connection.pool.end();
  }
});
