import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  connect,
  DatabaseUnavailableError,
  sql,
  withAdmin,
} from '@fs-billing/db';
import { apiErrorSchemas } from '@fs-billing/shared';
import { expect, inject, it } from 'vitest';
import { createApi } from './app.js';
import { apiConnections, fixtureApi } from '../test/support.js';

const connections = apiConnections();
const { auth } = fixtureApi(connections);

it('returns 503 for socket EOF during a query without retrying the transaction', async () => {
  const destination = new URL(inject('appUrl'));
  const sockets = new Set<Socket>();
  const backendSockets = new Set<Socket>();
  const proxy = createServer((downstream) => {
    const upstream = createConnection({
      host: destination.hostname,
      port: Number(destination.port || 5432),
    });
    sockets.add(downstream);
    sockets.add(upstream);
    backendSockets.add(upstream);
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.pipe(upstream);
    upstream.pipe(downstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('No proxy port');
  const url = new URL(destination);
  url.hostname = '127.0.0.1';
  url.port = String(address.port);
  const connection = connect(url.toString(), { max: 1 });
  const api = createApi({ businessDb: connection.db, auth });
  const marker = `socket_eof_${randomUUID().replaceAll('-', '')}`;
  let attempts = 0;
  let queryFailure: unknown;
  api.get('/test-socket-eof', () =>
    withAdmin(connection.db, async (tx) => {
      attempts += 1;
      try {
        await tx.execute(sql.raw(`select pg_sleep(30) /* ${marker} */`));
      } catch (error) {
        queryFailure = error;
        throw error;
      }
    }),
  );
  let pending: Promise<unknown> | undefined;
  try {
    const response = api.inject('/test-socket-eof').then((result) => result);
    pending = response;
    let running = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await connections.owner.pool.query<{ running: boolean }>(
        `select exists(select 1 from pg_stat_activity where state = 'active' and query like $1 and pid <> pg_backend_pid()) as running`,
        [`%${marker}%`],
      );
      if (result.rows[0]?.running) {
        running = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(running).toBe(true);
    // Close the proxy's backend socket and send real EOF to pg, without a SQLSTATE.
    for (const socket of backendSockets) socket.destroy();
    for (const socket of sockets) {
      if (!backendSockets.has(socket)) socket.end();
    }
    const result = await response;
    expect(result.statusCode, result.body).toBe(503);
    expect(attempts).toBe(1);
    expect(queryFailure).toHaveProperty(
      'cause',
      expect.any(DatabaseUnavailableError),
    );
    expect(queryFailure).toHaveProperty(
      'cause.cause.message',
      'Connection terminated unexpectedly',
    );
    expect(
      apiErrorSchemas.SERVICE_UNAVAILABLE.parse(result.json()).error.code,
    ).toBe('SERVICE_UNAVAILABLE');
  } finally {
    for (const socket of sockets) socket.destroy();
    await pending;
    await api.close();
    await connection.pool.end();
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
});

it('returns 503 for pool checkout timeout', async () => {
  const connection = connect(inject('appUrl'), {
    max: 1,
    connectionTimeoutMillis: 250,
  });
  const api = createApi({ businessDb: connection.db, auth });
  api.get('/test-pool-timeout', () =>
    withAdmin(connection.db, (tx) => tx.execute(sql`select 1`)),
  );
  const holder = await connection.pool.connect();
  try {
    const response = await api.inject('/test-pool-timeout');
    expect(response.statusCode, response.body).toBe(503);
    expect(
      apiErrorSchemas.SERVICE_UNAVAILABLE.parse(response.json()).error.code,
    ).toBe('SERVICE_UNAVAILABLE');
  } finally {
    holder.release();
    await api.close();
    await connection.pool.end();
  }
});
