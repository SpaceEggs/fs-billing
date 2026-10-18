import type { EventEmitter } from 'node:events';
import pg from 'pg';

interface ControlStream {
  readonly destroyed: boolean;
  destroy(): unknown;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

export interface ControlClientLifecycle {
  readonly connection: Pick<EventEmitter, 'removeListener'> & {
    readonly stream: ControlStream;
  };
  end(callback?: () => void): void;
}

/** Send PostgreSQL's backend cancel signal over a short-lived, bounded control connection. */
export async function cancelPostgresBackend(
  pool: pg.Pool,
  backendPid: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(backendPid) || backendPid < 1)
    throw new Error('PostgreSQL backend PID must be a positive integer');
  const connectionString = pool.options.connectionString;
  if (typeof connectionString !== 'string' || connectionString.length === 0)
    throw new Error('PostgreSQL cancellation requires a connection string');

  const client = new pg.Client({
    connectionString,
    application_name: 'fsbilling-api-export-cancel',
    connectionTimeoutMillis: 2_000,
    statement_timeout: 2_000,
    query_timeout: 2_000,
  });
  const onError = () => undefined;
  client.on('error', onError);
  try {
    await client.connect();
    const result = await client.query<{ cancelled: boolean }>(
      'select pg_cancel_backend($1) as cancelled',
      [backendPid],
    );
    return result.rows[0]?.cancelled === true;
  } finally {
    await endControlClient(client);
    client.removeListener('error', onError);
  }
}

export async function endControlClient(
  client: ControlClientLifecycle,
  gracefulTimeoutMs = 2_000,
  forcedCloseTimeoutMs = 250,
): Promise<void> {
  const stream = client.connection.stream;
  let ended = false;
  const onEnd = () => {
    ended = true;
  };
  client.end(onEnd);
  const closedGracefully = await waitForClose(stream, gracefulTimeoutMs);
  if (!closedGracefully) {
    stream.destroy();
    await waitForClose(stream, forcedCloseTimeoutMs);
  }
  if (!ended) client.connection.removeListener('end', onEnd);
}

function waitForClose(
  stream: ControlStream,
  timeoutMs: number,
): Promise<boolean> {
  if (stream.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      stream.removeListener('close', onClose);
      resolve(true);
    };
    const timer = setTimeout(() => {
      stream.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    stream.once('close', onClose);
  });
}
