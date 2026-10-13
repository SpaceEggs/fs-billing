import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { connections, createTenant, pgError } from '../test/support.js';
import { withAdmin, type Tx } from './client.js';
import { cdrs } from './schema.js';

const { app, owner } = connections();

function unanswered(tenantId: string, callUuid: string, startedAt: string) {
  const at = new Date(startedAt);
  return {
    tenantId,
    callUuid,
    startedAt: at,
    endedAt: new Date(at.getTime() + 30_000),
    caller: '075586001234',
    callee: '8613800138000',
    hangupCause: 'NO_ANSWER',
  };
}

const partitionOf = (tx: Tx, callUuid: string) =>
  tx.execute<{ partition: string }>(
    sql`select tableoid::regclass::text as partition from cdrs where call_uuid = ${callUuid}`,
  );

describe('话单按通话 UUID 唯一', () => {
  beforeAll(() =>
    withAdmin(app.db, (tx) =>
      tx.execute(
        sql`select cdr_ensure_partitions('2026-10-12T00:00:00+08:00')`,
      ),
    ),
  );

  it('同一 UUID 插入两次，第二次被唯一约束挡住', async () => {
    const tenant = await createTenant(app, 'CNY');
    const callUuid = randomUUID();
    const row = unanswered(tenant.id, callUuid, '2026-10-12T10:00:00+08:00');
    await withAdmin(app.db, (tx) => tx.insert(cdrs).values(row));
    const error = await pgError(
      withAdmin(app.db, (tx) => tx.insert(cdrs).values(row)),
    );
    expect(error).toMatchObject({
      code: '23505',
      constraint: 'cdr_call_uuids_pkey',
    });
  });

  it('同一 UUID 换了开始时间（落在另一个分区）也被挡住', async () => {
    const tenant = await createTenant(app, 'CNY');
    const callUuid = randomUUID();
    await withAdmin(app.db, (tx) =>
      tx
        .insert(cdrs)
        .values(unanswered(tenant.id, callUuid, '2026-10-31T23:59:50+08:00')),
    );
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        tx
          .insert(cdrs)
          .values(unanswered(tenant.id, callUuid, '2026-11-01T00:00:10+08:00')),
      ),
    );
    expect(error).toMatchObject({
      code: '23505',
      constraint: 'cdr_call_uuids_pkey',
    });
  });
});

describe('按月分区', () => {
  it('建分区任务幂等地建出当月与下月（北京时间），之后下月的话单落入新分区', async () => {
    const tenant = await createTenant(app, 'CNY');
    const ensure = () =>
      withAdmin(app.db, (tx) =>
        tx.execute<{ name: string }>(
          sql`select cdr_ensure_partitions('2027-01-15T12:00:00+08:00') as name`,
        ),
      );
    expect((await ensure()).rows).toEqual([
      { name: 'cdrs_2027_01' },
      { name: 'cdrs_2027_02' },
    ]);
    expect((await ensure()).rows).toEqual([
      { name: 'cdrs_2027_01' },
      { name: 'cdrs_2027_02' },
    ]);

    const lastOfJanuary = randomUUID();
    const firstOfFebruary = randomUUID();
    const placed = await withAdmin(app.db, async (tx) => {
      await tx
        .insert(cdrs)
        .values([
          unanswered(tenant.id, lastOfJanuary, '2027-01-31T23:59:59+08:00'),
          unanswered(tenant.id, firstOfFebruary, '2027-02-01T00:00:00+08:00'),
        ]);
      return [
        ...(await partitionOf(tx, lastOfJanuary)).rows,
        ...(await partitionOf(tx, firstOfFebruary)).rows,
      ];
    });
    expect(placed).toEqual([
      { partition: 'cdrs_2027_01' },
      { partition: 'cdrs_2027_02' },
    ]);

    const { rows } = await owner.pool.query(
      `SELECT pg_get_expr(c.relpartbound, c.oid) AS bound FROM pg_class c WHERE c.relname = 'cdrs_2027_02'`,
    );
    expect(rows).toEqual([
      {
        bound:
          "FOR VALUES FROM ('2027-01-31 16:00:00+00') TO ('2027-02-28 16:00:00+00')",
      },
    ]);
  });

  it('没有分区的月份插入失败，不会悄悄落入兜底分区', async () => {
    const tenant = await createTenant(app, 'CNY');
    const error = await pgError(
      withAdmin(app.db, (tx) =>
        tx
          .insert(cdrs)
          .values(
            unanswered(tenant.id, randomUUID(), '2030-06-01T12:00:00+08:00'),
          ),
      ),
    );
    expect([error.code, error.message]).toEqual([
      '23514',
      'no partition of relation "cdrs" found for row',
    ]);
  });

  it('迁移已建出当前月与下个月的分区', async () => {
    const { rows } = await owner.pool.query<{
      existing: string[];
      expected: string[];
    }>(
      `SELECT array_agg(c.relname::text ORDER BY c.relname) AS existing,
              ARRAY[
                'cdrs_' || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYY_MM'),
                'cdrs_' || to_char((now() AT TIME ZONE 'Asia/Shanghai') + interval '1 month', 'YYYY_MM')
              ] AS expected
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent = 'cdrs'::regclass`,
    );
    expect(rows[0]!.existing).toEqual(
      expect.arrayContaining(rows[0]!.expected),
    );
  });
});
