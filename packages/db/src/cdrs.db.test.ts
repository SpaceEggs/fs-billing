import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CDR_VALIDATION_FAILURE_PREFIX,
  INVALID_NUMBER_REASON,
} from '../../shared/src/worker.js';
import { connections, createTenant, pgError } from '../test/support.js';
import { withAdmin, type Tx } from './client.js';
import { ensureCdrPartitions } from './partitions.js';
import { cdrs, rawCdrs, unassignedCdrs } from './schema.js';

const { app, owner } = connections();

function unanswered(tenantId: string, callUuid: string, startedAt: string) {
  const at = new Date(startedAt);
  return {
    tenantId,
    callUuid,
    startedAt: at,
    endedAt: new Date(at.getTime() + 30_000),
    caller: '075586001234',
    callee: '13800138000',
    billingNumber: '8613800138000',
    hangupCause: 'NO_ANSWER',
  };
}

const partitionOf = (tx: Tx, callUuid: string) =>
  tx.execute<{ partition: string }>(
    sql`select tableoid::regclass::text as partition from cdrs where call_uuid = ${callUuid}`,
  );

describe('话单按通话 UUID 唯一', () => {
  beforeAll(() =>
    ensureCdrPartitions(app.db, {
      moment: new Date('2026-10-12T00:00:00+08:00'),
    }),
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
      constraint: 'call_uuids_pkey',
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
      constraint: 'call_uuids_pkey',
    });
  });
});

describe('正式话单与未归属话单共用 UUID 登记表', () => {
  const startedAt = '2026-10-12T11:00:00+08:00';
  const parkUnassigned = (callUuid: string) =>
    withAdmin(app.db, (tx) =>
      tx.insert(unassignedCdrs).values({
        tenantTag: 'ABC01',
        callUuid,
        reason: '找不到租户',
        startedAt: new Date(startedAt),
        endedAt: new Date(startedAt),
        caller: '075586001299',
        callee: '+6591234567',
        billingNumber: '6591234567',
      }),
    );
  const insertCdr = (tenantId: string, callUuid: string) =>
    withAdmin(app.db, (tx) =>
      tx.insert(cdrs).values(unanswered(tenantId, callUuid, startedAt)),
    );
  const registration = async (callUuid: string) =>
    (
      await owner.pool.query<{ tenant_id: string | null }>(
        'SELECT tenant_id FROM call_uuids WHERE call_uuid = $1',
        [callUuid],
      )
    ).rows;

  it('未归属话单登记的 UUID，之后由正式话单认领', async () => {
    const tenant = await createTenant(app, 'CNY');
    const callUuid = randomUUID();
    await parkUnassigned(callUuid);
    expect(await registration(callUuid)).toEqual([{ tenant_id: null }]);
    await insertCdr(tenant.id, callUuid);
    expect(await registration(callUuid)).toEqual([{ tenant_id: tenant.id }]);
  });

  it('已在正式话单中的 UUID 再进未归属话单被拒绝', async () => {
    const tenant = await createTenant(app, 'CNY');
    const callUuid = randomUUID();
    await insertCdr(tenant.id, callUuid);
    expect(await pgError(parkUnassigned(callUuid))).toMatchObject({
      code: '23505',
      constraint: 'call_uuids_pkey',
    });
  });

  it('同一 UUID 已归属一个租户后，再给第二个租户被拒绝', async () => {
    const first = await createTenant(app, 'CNY');
    const second = await createTenant(app, 'CNY');
    const callUuid = randomUUID();
    await parkUnassigned(callUuid);
    await insertCdr(first.id, callUuid);
    expect(await pgError(insertCdr(second.id, callUuid))).toMatchObject({
      code: '23505',
      constraint: 'call_uuids_pkey',
      message:
        'duplicate key value violates unique constraint "call_uuids_pkey"',
    });
    expect(await registration(callUuid)).toEqual([{ tenant_id: first.id }]);
  });
});

describe('原始话单', () => {
  it('原文逐字节保存：空白、键序、重复键原样读回；payload 是可查询的规范化副本', async () => {
    const body =
      '{ "variables" : {"uuid":"7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60",\n' +
      '  "billsec":"230",  "billsec":"231"},\t"z":1, "a":[ 1 ,2 ] }\n';
    const rows = await withAdmin(app.db, async (tx) => {
      await tx.insert(rawCdrs).values({
        body,
        receivedAt: new Date('2026-10-31T23:59:59+08:00'),
      });
      return (
        await tx.execute(sql`
          select body, payload::text as payload, tableoid::regclass::text as partition
          from raw_cdrs where body = ${body}`)
      ).rows;
    });
    expect(rows).toEqual([
      {
        body:
          '{ "variables" : {"uuid":"7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60",\n' +
          '  "billsec":"230",  "billsec":"231"},\t"z":1, "a":[ 1 ,2 ] }\n',
        payload:
          '{"a": [1, 2], "z": 1, "variables": {"uuid": "7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60", "billsec": "231"}}',
        partition: 'raw_cdrs_2026_10',
      },
    ]);
  });

  it('不是合法 JSON 的原文也保存，payload 为空', async () => {
    const rows = await withAdmin(app.db, async (tx) => {
      await tx.insert(rawCdrs).values({ body: '{"uuid": "truncated' });
      await tx.insert(rawCdrs).values({ body: '{"note":"\\u0000"}' });
      return (
        await tx.execute(sql`
          select body, payload from raw_cdrs
          where body in ('{"uuid": "truncated', '{"note":"\\u0000"}') order by body`)
      ).rows;
    });
    expect(rows).toEqual([
      { body: '{"note":"\\u0000"}', payload: null },
      { body: '{"uuid": "truncated', payload: null },
    ]);
  });

  it('数值溢出的 JSON 原文仍保存，payload 为空', async () => {
    const body = '{"n":1e1000000}';
    const rows = await withAdmin(app.db, async (tx) => {
      await tx.insert(rawCdrs).values({ body });
      return (
        await tx.execute(
          sql`select body, payload from raw_cdrs where body = ${body}`,
        )
      ).rows;
    });
    expect(rows).toEqual([{ body: '{"n":1e1000000}', payload: null }]);
  });
});

describe('按月分区', () => {
  it('维护入口在类型层拒绝事务，只接受连接池数据库', () => {
    const insideWrite = (tx: Tx) => {
      // @ts-expect-error 事务没有连接池 $client，维护不能嵌套在写事务里
      return ensureCdrPartitions(tx);
    };
    expect(insideWrite).toBeTypeOf('function');
  });

  it('建分区任务幂等地建出 cdrs 与 raw_cdrs 的当月与下月（北京时间），之后下月的话单落入新分区', async () => {
    const tenant = await createTenant(app, 'CNY');
    const ensure = () =>
      ensureCdrPartitions(app.db, {
        moment: new Date('2027-01-15T12:00:00+08:00'),
      });
    const expected = [
      'cdrs_2027_01',
      'cdrs_2027_02',
      'raw_cdrs_2027_01',
      'raw_cdrs_2027_02',
    ];
    expect(await ensure()).toEqual(expected);
    expect(await ensure()).toEqual(expected);

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

  it('分区已存在时不等待建分区锁；缺分区时才加锁', async () => {
    const holder = await owner.pool.connect();
    const ensureWithin300ms = (moment: string) =>
      withAdmin(app.db, async (tx) => {
        await tx.execute(sql`set local lock_timeout = '300ms'`);
        return (
          await tx.execute<{ name: string }>(
            sql`select cdr_ensure_partitions(${moment}) as name`,
          )
        ).rows.length;
      });
    try {
      await holder.query('BEGIN');
      await holder.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('partition:cdrs_2026_10', 0)),
                pg_advisory_xact_lock(hashtextextended('partition:cdrs_2031_03', 0))`,
      );
      expect(await ensureWithin300ms('2026-10-12T00:00:00+08:00')).toBe(4);
      const blocked = await pgError(
        ensureWithin300ms('2031-03-15T00:00:00+08:00'),
      );
      expect([blocked.code, blocked.message]).toEqual([
        '55P03',
        'canceling statement due to lock timeout',
      ]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('迁移已建出 cdrs 与 raw_cdrs 当前月与下个月的分区', async () => {
    const { rows } = await owner.pool.query<{
      existing: string[];
      expected: string[];
    }>(
      `SELECT array_agg(c.relname::text ORDER BY c.relname) AS existing,
              ARRAY(
                SELECT parent || '_' || to_char(m, 'YYYY_MM')
                FROM unnest(ARRAY['cdrs', 'raw_cdrs']) AS parent,
                  unnest(ARRAY[now() AT TIME ZONE 'Asia/Shanghai',
                               (now() AT TIME ZONE 'Asia/Shanghai') + interval '1 month']) AS m
              ) AS expected
       FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
       WHERE i.inhparent IN ('cdrs'::regclass, 'raw_cdrs'::regclass)`,
    );
    expect(rows[0]!.existing).toEqual(
      expect.arrayContaining(rows[0]!.expected),
    );
  });
});

describe('计费号码约束', () => {
  it.each([null, '12345', '012345', '1234567890123456'])(
    '正式话单拒绝无效计费号码 %j',
    async (billingNumber) => {
      const tenant = await createTenant(app, 'CNY');
      const row = unanswered(
        tenant.id,
        randomUUID(),
        '2026-10-12T12:00:00+08:00',
      );
      const error = await pgError(
        withAdmin(app.db, (tx) =>
          tx.execute(sql`
        insert into cdrs (tenant_id, call_uuid, started_at, ended_at, caller, callee, billing_number)
        values (${row.tenantId}, ${row.callUuid}, ${row.startedAt}, ${row.endedAt}, ${row.caller}, ${row.callee}, ${billingNumber})
      `),
        ),
      );
      expect(error.code).toBe(billingNumber === null ? '23502' : '23514');
    },
  );

  it.each([
    { reason: INVALID_NUMBER_REASON, billingNumber: null, valid: true },
    {
      reason: `${CDR_VALIDATION_FAILURE_PREFIX}billing_dialed_number 缺失`,
      billingNumber: null,
      valid: true,
    },
    {
      reason: `${CDR_VALIDATION_FAILURE_PREFIX}话单时间与时长不一致`,
      billingNumber: null,
      valid: true,
    },
    { reason: '租户不存在', billingNumber: '447700900123', valid: true },
    { reason: '计费号码不一致', billingNumber: '447700900123', valid: true },
    { reason: '租户不存在', billingNumber: null, valid: false },
    { reason: '计费号码不一致', billingNumber: null, valid: false },
    {
      reason: INVALID_NUMBER_REASON,
      billingNumber: '447700900123',
      valid: false,
    },
    {
      reason: `${CDR_VALIDATION_FAILURE_PREFIX}话单时间与时长不一致`,
      billingNumber: '447700900123',
      valid: false,
    },
    { reason: '租户不存在', billingNumber: '12345', valid: false },
  ])(
    '未归属号码与原因对应 $reason / $billingNumber',
    async ({ reason, billingNumber, valid }) => {
      const insert = withAdmin(app.db, (tx) =>
        tx.insert(unassignedCdrs).values({
          callUuid: randomUUID(),
          startedAt: new Date('2026-10-12T12:00:00+08:00'),
          endedAt: new Date('2026-10-12T12:00:00+08:00'),
          caller: '',
          callee: '',
          reason,
          billingNumber,
        }),
      );
      if (valid) {
        await insert;
      } else {
        expect((await pgError(insert)).code).toBe('23514');
      }
    },
  );
});

it('cdrs_iso_check rejects lowercase ISO and accepts NULL on the real partitioned table', async () => {
  const startedAt = '2026-10-12T10:00:00+08:00';
  await ensureCdrPartitions(app.db, { moment: new Date(startedAt) });
  const tenant = await createTenant(app, 'CNY');
  const row = (iso: string | null) => ({
    ...unanswered(tenant.id, randomUUID(), startedAt),
    answeredAt: new Date(startedAt),
    durationSeconds: 30,
    billedMinutes: '1',
    matchedPrefix: '44',
    callee: '442071234567',
    billingNumber: '442071234567',
    hangupCause: 'NORMAL_CLEARING',
    country: '英国',
    rate: '0.02',
    charge: '0.02',
    iso,
  });
  for (const iso of [null, 'GB']) {
    const stored = await withAdmin(app.db, (tx) =>
      tx
        .insert(cdrs)
        .values(row(iso))
        .returning({ callUuid: cdrs.callUuid, iso: cdrs.iso }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]?.iso).toBe(iso);
    const partition = await withAdmin(app.db, (tx) =>
      partitionOf(tx, stored[0]!.callUuid),
    );
    expect(partition.rows).toEqual([{ partition: 'cdrs_2026_10' }]);
  }
  for (const iso of ['gb', 'GBR']) {
    expect(
      await pgError(
        withAdmin(app.db, (tx) => tx.insert(cdrs).values(row(iso))),
      ),
    ).toMatchObject({ code: '23514', constraint: 'cdrs_iso_check' });
  }
});
