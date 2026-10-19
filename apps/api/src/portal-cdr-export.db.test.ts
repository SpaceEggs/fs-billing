import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ensureCdrPartitions } from '@fs-billing/db';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';
import { apiErrorSchema } from '@fs-billing/shared';

const connections = apiConnections();
const exportApplicationName = 'fsbilling-api-export-pr3-http';
const { api } = fixtureApi(connections, {
  exportPoolApplicationName: exportApplicationName,
});
let fixture: Fixture;

beforeAll(async () => {
  fixture = await createFixture(connections);
  await ensureCdrPartitions(connections.owner.db, { moment: new Date() });
});

describe('portal CDR export HTTP lifecycle', () => {
  it('returns the contract JSON error before hijacking when the first cursor batch is cancelled', async () => {
    const tenantId = fixture.a.tenantId;
    if (!tenantId) throw new Error('Expected portal tenant to exist');
    const session = await login(api, fixture.a);
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const locker = await connections.owner.pool.connect();
    await locker.query('begin');
    await locker.query('lock table public.cdrs in access exclusive mode');

    try {
      const pending = api.inject({
        method: 'POST',
        url: '/api/portal/cdrs/export',
        headers: requestHeaders(session.cookie),
        payload: { from: `${day.slice(0, 7)}-01`, to: day },
      });
      let backend: { pid: number; waitEvent: string | null } | undefined;
      const deadline = Date.now() + 5_000;
      while (!backend && Date.now() < deadline) {
        const activity = await connections.owner.pool.query<{
          pid: number;
          waitEvent: string | null;
        }>(
          `select pid, wait_event as "waitEvent" from pg_stat_activity
           where application_name = $1 and state = 'active'
             and wait_event_type = 'Lock'`,
          [exportApplicationName],
        );
        backend = activity.rows[0];
        if (!backend) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(backend).toBeDefined();
      if (!backend)
        throw new Error('First cursor fetch did not wait on the CDR lock');
      expect(backend.waitEvent).toBe('relation');
      const cancelled = await connections.owner.pool.query<{
        cancelled: boolean;
      }>('select pg_cancel_backend($1) as cancelled', [backend.pid]);
      expect(cancelled.rows[0]?.cancelled).toBe(true);

      const response = await pending;
      expect(response.statusCode).toBe(500);
      expect(response.headers['content-type']).toContain('application/json');
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        'INTERNAL_ERROR',
      );
    } finally {
      await locker.query('rollback');
      locker.release();
    }
  });

  it('destroys an incomplete HTTP response after PostgreSQL ends the cursor and releases the tenant slot', async () => {
    const tenantId = fixture.a.tenantId;
    if (!tenantId) throw new Error('Expected portal tenant to exist');
    const startedAt = new Date(Date.now() - 60_000);
    const answeredAt = new Date(Date.now() - 30_000);
    const endedAt = new Date();
    await connections.owner.pool.query(
      `insert into public.cdrs
        (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
         billing_number, duration_seconds, billed_minutes, matched_prefix, country,
         rate, charge, hangup_cause, unverified)
       select $1::uuid, gen_random_uuid(), $2, $3, $4, '1001', $5,
         '8613800138001', 60, 1, '86', '中国', 1234.1234, 0.01,
         'NORMAL_CLEARING', false
       from generate_series(1, 5000) as n`,
      [tenantId, startedAt, answeredAt, endedAt, 'X'.repeat(2_000)],
    );

    const session = await login(api, fixture.a);
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${address}/api/portal/cdrs/export`, {
      method: 'POST',
      headers: {
        ...requestHeaders(session.cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: `${day.slice(0, 7)}-01`, to: day }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Expected a streaming response body');
    const first = await reader.read();
    if (first.done || !first.value)
      throw new Error('CSV response ended before its first batch');
    expect(
      new TextDecoder().decode(z.instanceof(Uint8Array).parse(first.value)),
    ).toContain('接通时间');

    const idleDeadline = Date.now() + 5_000;
    let exportBackend: { pid: number; state: string } | undefined;
    while (!exportBackend && Date.now() < idleDeadline) {
      const activity = await connections.owner.pool.query<{
        pid: number;
        state: string;
      }>(
        `select pid, state from pg_stat_activity
         where application_name = $1
           and state = 'idle in transaction'`,
        [exportApplicationName],
      );
      exportBackend = activity.rows[0];
      if (!exportBackend)
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(exportBackend).toBeDefined();
    if (!exportBackend)
      throw new Error('Export did not wait on client backpressure');
    const terminated = await connections.owner.pool.query<{
      terminated: boolean;
    }>('select pg_terminate_backend($1) as terminated', [exportBackend.pid]);
    expect(terminated.rows[0]?.terminated).toBe(true);

    let incomplete = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
      }
    } catch {
      incomplete = true;
    }
    expect(incomplete).toBe(true);

    const retry = await fetch(`${address}/api/portal/cdrs/export`, {
      method: 'POST',
      headers: {
        ...requestHeaders(session.cookie),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: `${day.slice(0, 7)}-01`, to: day }),
    });
    expect(retry.status).toBe(200);
    const retryCsv = await retry.text();
    expect(retryCsv).toContain('接通时间');
    expect(retryCsv).toContain('NORMAL_CLEARING');
    expect(retryCsv).not.toContain('unverified');
  });
});
