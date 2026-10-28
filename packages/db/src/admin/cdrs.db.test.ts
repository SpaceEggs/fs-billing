import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminCdrExportRequestSchema,
  type AuditActor,
} from '@fs-billing/shared';
import { adminId, connections, createTenant } from '../../test/support.js';
import { withAdmin } from '../client.js';
import { ensureCdrPartitions } from '../partitions.js';
import { cdrs, operationLogs } from '../schema.js';
import { acceptAdminCdrExport } from './cdrs.js';

const { app, owner } = connections();
let actor: AuditActor;

beforeAll(async () => {
  actor = { id: await adminId(owner), name: '系统管理员' };
  await ensureCdrPartitions(app.db, { moment: new Date() });
});

describe('admin CDR export acceptance audit', () => {
  it('keeps four decimal places when a rate has more integer digits than to_char masks', async () => {
    const { rows } = await app.pool.query<{
      rate: string;
      scale: number;
      paddedRate: string;
    }>(`select round(123456789012345678901234567890.1234::numeric, 4)::text as rate,
      scale(round(123456789012345678901234567890.1234::numeric, 4))::int as scale,
      round(1.2::numeric, 4)::text as "paddedRate"`);
    expect(rows).toEqual([
      {
        rate: '123456789012345678901234567890.1234',
        scale: 4,
        paddedRate: '1.2000',
      },
    ]);
  });

  it('counts the normalized filter and commits one audit before the stream', async () => {
    const tenant = await createTenant(app, 'CNY');
    const answeredAt = new Date();
    const startedAt = new Date(answeredAt.getTime() - 60_000);
    await withAdmin(app.db, (tx) =>
      tx.insert(cdrs).values({
        iso: null,
        description: null,
        tenantId: tenant.id,
        callUuid: randomUUID(),
        startedAt,
        answeredAt,
        endedAt: new Date(answeredAt.getTime() + 60_000),
        caller: '1001',
        callee: '+86 138-0013 8001',
        billingNumber: '8613800138001',
        durationSeconds: 60,
        billedMinutes: '1',
        matchedPrefix: '86',
        country: '中国',
        rate: '0.25',
        charge: '0.25',
        hangupCause: 'NORMAL_CLEARING',
        unverified: true,
      }),
    );
    const day = new Date(answeredAt.getTime() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const query = adminCdrExportRequestSchema.parse({
      from: `${day.slice(0, 7)}-01`,
      to: day,
      callee: '+86 138-0013 8001',
      unverifiedOnly: true,
    });
    const accepted = await acceptAdminCdrExport({
      db: app.db,
      tenantId: tenant.id,
      actor,
      query,
      signal: new AbortController().signal,
    });
    expect(accepted).toEqual({ code: tenant.code, rowCount: 1 });

    const records = await withAdmin(app.db, (tx) =>
      tx
        .select()
        .from(operationLogs)
        .where(
          and(
            eq(operationLogs.tenantId, tenant.id),
            eq(operationLogs.action, 'cdr_export'),
          ),
        ),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.adminId).toBe(actor.id);
    expect(records[0]?.details).toMatchObject({
      actor,
      target: { kind: 'tenant', id: tenant.id },
      content: {
        rowCount: 1,
        filters: {
          from: query.from,
          to: query.to,
          status: 'answered',
          callee: '8613800138001',
          unverifiedOnly: true,
        },
      },
    });
  });

  it('aborts the checked-out audit connection when its deadline fires in the count', async () => {
    const tenant = await createTenant(app, 'CNY');
    const locker = await owner.pool.connect();
    await locker.query('begin');
    await locker.query('lock table public.cdrs in access exclusive mode');
    const controller = new AbortController();
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const pending = acceptAdminCdrExport({
      db: app.db,
      tenantId: tenant.id,
      actor,
      query: adminCdrExportRequestSchema.parse({
        from: `${day.slice(0, 7)}-01`,
        to: day,
      }),
      signal: controller.signal,
    });

    try {
      let waiting:
        | {
            pid: number;
            state: string;
            waitEventType: string | null;
            waitEvent: string | null;
          }
        | undefined;
      const deadline = Date.now() + 5_000;
      while (!waiting && Date.now() < deadline) {
        const activity = await owner.pool.query<{
          pid: number;
          state: string;
          waitEventType: string | null;
          waitEvent: string | null;
        }>(
          `select pid, state, wait_event_type as "waitEventType",
             wait_event as "waitEvent" from pg_stat_activity
           where pid <> pg_backend_pid() and datname = current_database()
             and state = 'active'
             and wait_event_type = 'Lock' and query ilike '%cdrs c%'`,
        );
        waiting = activity.rows[0];
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBeDefined();
      if (!waiting)
        throw new Error('Export count never waited on the CDR lock');
      const abortStarted = performance.now();
      controller.abort(new Error('export deadline elapsed'));
      await expect(pending).rejects.toThrow('export deadline elapsed');

      const audits = await owner.pool.query<{ total: number }>(
        `select count(*)::int as total from public.operation_logs
         where tenant_id = $1 and action = 'cdr_export'`,
        [tenant.id],
      );
      expect(audits.rows[0]?.total).toBe(0);
      let after = await owner.pool.query<{
        state: string;
        waitEventType: string | null;
        waitEvent: string | null;
      }>(
        `select state, wait_event_type as "waitEventType",
           wait_event as "waitEvent" from pg_stat_activity where pid = $1`,
        [waiting.pid],
      );
      const cleanupDeadline = Date.now() + 5_000;
      while (
        after.rows.some((row) => row.state !== 'idle') &&
        Date.now() < cleanupDeadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        after = await owner.pool.query<{
          state: string;
          waitEventType: string | null;
          waitEvent: string | null;
        }>(
          `select state, wait_event_type as "waitEventType",
             wait_event as "waitEvent" from pg_stat_activity where pid = $1`,
          [waiting.pid],
        );
      }
      const elapsedMs = Math.round(performance.now() - abortStarted);
      process.stdout.write(
        `\nPR3_PREPARE_ABORT ${JSON.stringify({
          backendPid: waiting.pid,
          before: {
            state: waiting.state,
            waitEventType: waiting.waitEventType,
            waitEvent: waiting.waitEvent,
          },
          after: after.rows[0] ?? null,
          elapsedMs,
        })}\n`,
      );
      expect(after.rows.every((row) => row.state === 'idle')).toBe(true);
      expect(app.pool.waitingCount).toBe(0);
      const reusable = await app.pool.query<{ scope: string | null }>(
        "select nullif(current_setting('app.scope', true), '') as scope",
      );
      expect(reusable.rows[0]?.scope).toBeNull();
      expect(app.pool.idleCount).toBe(app.pool.totalCount);
    } finally {
      await locker.query('rollback');
      locker.release();
    }
  });
});
