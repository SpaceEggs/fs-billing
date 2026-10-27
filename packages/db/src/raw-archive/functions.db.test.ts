import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { pgError } from '../../test/support.js';
import { scratchDatabase } from '../../test/scratch.js';
import {
  fixtureId,
  seedRawMonth,
  temporaryStore,
} from '../../test/raw-archive.js';
import { lockTenants, withSystem, withTenant, withAdmin } from '../client.js';
import { loadManifest } from './manifest.js';
import { archiveMonth, type ArchiveOptions } from './run.js';

const db = scratchDatabase({ seed: true });
const archive = temporaryStore();
const options: ArchiveOptions = { afterMonths: 6, graceDays: 7 };

const query = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => (await db.owner.pool.query<T>(text, values)).rows;
const one = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => (await query<T>(text, values))[0]!;
const partitionOf = (month: string) =>
  `raw_cdrs_${month.slice(0, 4)}_${month.slice(5, 7)}`;
const attached = async (month: string) =>
  (
    await one<{ found: boolean }>(
      `select exists (select from pg_inherits where inhrelid = to_regclass($1)
         and inhparent = 'raw_cdrs'::regclass) as found`,
      [partitionOf(month)],
    )
  ).found;

let counter = 0;
const newMonth = () => `2005-${String(++counter).padStart(2, '0')}-01`;

const rowsFor = (month: string, n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: fixtureId(index + 1),
    receivedAt: `${new Date(
      Date.parse(`${month.slice(0, 7)}-10T00:00:00Z`) + index * 1000,
    )
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ')}.000001+00`,
    body: `{"n":${index}}\n`,
  }));

/** 经过校验、清单为 verified、分区仍然挂着：分离函数的前置状态。 */
async function verifiedMonth(rows = 10) {
  const month = newMonth();
  await seedRawMonth(db.app, db.owner, month, rowsFor(month, rows));
  await archiveMonth(db.app.db, archive.store, month, {
    ...options,
    onCheckpoint: (point) => {
      if (point === 'detach-in-transaction')
        throw new Error('stop before the detach');
    },
  }).catch(() => undefined);
  const manifest = (await loadManifest(db.app.db, month))!;
  expect(manifest.verifiedAt).toBeInstanceOf(Date);
  return { month, manifest };
}

const callDetach = (month: string, fingerprint: unknown) =>
  withSystem(db.app.db, (tx) =>
    tx.execute(
      sql`select raw_cdrs_detach_partition(${month}::date, ${JSON.stringify(fingerprint)}::jsonb)`,
    ),
  );

describe('归档函数的权限与保护', () => {
  it('grants the archive functions to the application role only', async () => {
    const functions = [
      'raw_cdrs_export_cursor(date, boolean)',
      'raw_cdrs_detach_partition(date, jsonb)',
      'raw_cdrs_drop_detached(date)',
      'raw_cdrs_reattach_partition(date)',
    ];
    for (const name of functions) {
      const row = await one<{
        app: boolean;
        acl: string;
        secdef: boolean;
        config: string[] | null;
      }>(
        `select has_function_privilege('fs_billing_app', $1, 'EXECUTE') as app,
                coalesce(p.proacl::text, '') as acl, p.prosecdef as secdef, p.proconfig as config
         from pg_proc p where p.oid = $1::regprocedure`,
        [name],
      );
      expect(row.app, name).toBe(true);
      expect(row.secdef, name).toBe(true);
      // PUBLIC 的授权在 aclitem 里是空的被授权者（「=X/owner」）。
      expect(row.acl, name).not.toMatch(/(^\{|,)=X\//);
      expect(row.config, name).toContain('search_path=public, pg_temp');
    }
    const timeouts = await query<{ proname: string; config: string[] }>(
      `select proname, proconfig as config from pg_proc where proname in
         ('raw_cdrs_detach_partition', 'raw_cdrs_drop_detached', 'raw_cdrs_reattach_partition', 'ensure_month_partition')
       order by 1`,
    );
    expect(
      timeouts.map((row) => [
        row.proname,
        row.config.filter((entry) => entry.startsWith('lock_timeout')),
      ]),
    ).toEqual([
      ['ensure_month_partition', ['lock_timeout=2s']],
      ['raw_cdrs_detach_partition', ['lock_timeout=3s']],
      ['raw_cdrs_drop_detached', ['lock_timeout=3s']],
      ['raw_cdrs_reattach_partition', ['lock_timeout=3s']],
    ]);
  });

  it('rejects callers that are not an operator and cannot touch partitions directly', async () => {
    const { month } = await verifiedMonth(3);
    const fingerprint = (await loadManifest(db.app.db, month))!.dbFingerprint;
    const tenant = (await one<{ id: string }>(`select id from tenants limit 1`))
      .id;
    const calls = [
      sql`select raw_cdrs_export_cursor(${month}::date, true)`,
      sql`select raw_cdrs_detach_partition(${month}::date, ${JSON.stringify(fingerprint)}::jsonb)`,
      sql`select raw_cdrs_drop_detached(${month}::date)`,
      sql`select raw_cdrs_reattach_partition(${month}::date)`,
    ];
    for (const call of calls) {
      const asTenant = await pgError(
        withTenant(db.app.db, tenant, (tx) => tx.execute(call)),
      );
      expect(asTenant.code).toBe('42501');
      const noScope = await pgError(db.app.db.execute(call));
      expect(noScope.code).toBe('42501');
    }
    // 应用角色自己不能 DETACH / DROP / 直接读分区。
    for (const statement of [
      `alter table raw_cdrs detach partition ${partitionOf(month)}`,
      `drop table ${partitionOf(month)}`,
      `select count(*) from ${partitionOf(month)}`,
    ]) {
      const error = await pgError(
        withSystem(db.app.db, (tx) => tx.execute(sql.raw(statement))),
      );
      expect(error.code, statement).toBe('42501');
    }
    expect(await attached(month)).toBe(true);
  });

  it('rejects detaching under a tenant lock, an unverified month or a wrong fingerprint', async () => {
    const { month, manifest } = await verifiedMonth(4);
    const tenant = (await one<{ id: string }>(`select id from tenants limit 1`))
      .id;
    const underLock = await pgError(
      withSystem(db.app.db, async (tx) => {
        await lockTenants(tx, [tenant]);
        await tx.execute(
          sql`select raw_cdrs_detach_partition(${month}::date, ${JSON.stringify(manifest.dbFingerprint)}::jsonb)`,
        );
      }),
    );
    expect(underLock.code).toBe('55000');

    const wrong = await pgError(
      callDetach(month, { ...manifest.dbFingerprint!, count: 999 }),
    );
    expect(wrong).toMatchObject({ code: '22000' });

    // 清单里没有这个月 / 还没校验。
    const unknown = newMonth();
    await seedRawMonth(db.app, db.owner, unknown, rowsFor(unknown, 2));
    expect(
      (await pgError(callDetach(unknown, manifest.dbFingerprint))).code,
    ).toBe('55000');
    await db.owner.pool.query(
      `insert into raw_cdr_archives (month, state) values ($1, 'exporting')`,
      [unknown],
    );
    expect(
      (await pgError(callDetach(unknown, manifest.dbFingerprint))).code,
    ).toBe('55000');

    // 月份必须是 1 日。
    expect(
      (await pgError(callDetach('2005-03-02', manifest.dbFingerprint))).code,
    ).toBe('22023');
    expect(await attached(month)).toBe(true);
    expect(await attached(unknown)).toBe(true);
  });

  it('refuses to detach when the partition changed after the export, and leaves it attached', async () => {
    const { month, manifest } = await verifiedMonth(4);
    await db.owner.pool.query(
      `insert into raw_cdrs (id, received_at, body) values ($1, $2, 'late')`,
      [randomUUID(), `${month.slice(0, 7)}-12 00:00:00+00`],
    );
    const error = await pgError(callDetach(month, manifest.dbFingerprint));
    expect(error.code).toBe('XX001');
    expect(error.message).toContain('内容与导出时不一致');
    expect(await attached(month)).toBe(true);
  });

  it('drops only a verified, detached table and tolerates one that is already gone', async () => {
    const { month, manifest } = await verifiedMonth(4);
    const drop = () =>
      withSystem(db.app.db, (tx) =>
        tx.execute(sql`select raw_cdrs_drop_detached(${month}::date)`),
      );
    // 分区还挂着、清单还没有 detached：拒绝。
    expect((await pgError(drop())).code).toBe('55000');
    await callDetach(month, manifest.dbFingerprint);
    // 已分离但清单还没记（模拟：回退清单）：仍然拒绝，函数以清单为准。
    expect((await pgError(drop())).code).toBe('55000');
    await db.owner.pool.query(
      `update raw_cdr_archives set state = 'detached', detached_at = now() where month = $1`,
      [month],
    );
    await drop();
    expect(
      (
        await one<{ found: boolean }>(
          `select to_regclass($1) is not null as found`,
          [`${partitionOf(month)}_archived`],
        )
      ).found,
    ).toBe(false);
    // 表已经没了（人工删过）：幂等返回。
    await drop();
    // 清单已记为 dropped：不能再丢。
    await db.owner.pool.query(
      `update raw_cdr_archives set state = 'dropped', dropped_at = now() where month = $1`,
      [month],
    );
    expect((await pgError(drop())).code).toBe('55000');
  });

  it('never drops a table that is still attached to raw_cdrs', async () => {
    const { month } = await verifiedMonth(2);
    // 构造一张仍挂在父表下的 _archived 表：把分区本身改名，并让清单说它已分离。
    await db.owner.pool.query(
      `alter table ${partitionOf(month)} rename to ${partitionOf(month)}_archived`,
    );
    await db.owner.pool.query(
      `update raw_cdr_archives set state = 'detached', detached_at = now() where month = $1`,
      [month],
    );
    const error = await pgError(
      withSystem(db.app.db, (tx) =>
        tx.execute(sql`select raw_cdrs_drop_detached(${month}::date)`),
      ),
    );
    expect(error.code).toBe('55000');
    expect(error.message).toContain('仍然挂在父表下');
  });
});

describe('raw_cdr_archives', () => {
  const insert = (values: Record<string, unknown>) => {
    const columns = Object.keys(values);
    return db.owner.pool.query(
      `insert into raw_cdr_archives (${columns.join(', ')}) values (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      Object.values(values),
    );
  };
  const manifest = {
    file_key: 'raw-cdrs/2001/raw-cdrs-2001-01.jsonl.gz',
    rows: 1,
    body_bytes: 1,
    file_bytes: 1,
    file_sha256: 'a'.repeat(64),
    rows_digest: 'b'.repeat(64),
    db_fingerprint: '{}',
    chunks: '[]',
  };

  it('only accepts a month start and consistent state/time combinations', async () => {
    const bad: [string, Record<string, unknown>][] = [
      [
        'not the first of the month',
        { month: '2001-02-03', state: 'exporting' },
      ],
      ['unknown state', { month: '2001-02-01', state: 'running' }],
      [
        'verified without a manifest',
        { month: '2001-02-01', state: 'verified', verified_at: new Date() },
      ],
      [
        'verified without a time',
        { month: '2001-02-01', state: 'verified', ...manifest },
      ],
      [
        'exporting that already has a verified time',
        { month: '2001-02-01', state: 'exporting', verified_at: new Date() },
      ],
      [
        'detached without a detach time',
        {
          month: '2001-02-01',
          state: 'detached',
          verified_at: new Date(),
          ...manifest,
        },
      ],
      [
        'detach time without a verified time',
        { month: '2001-02-01', state: 'failed', detached_at: new Date() },
      ],
      [
        'drop time without a detach time',
        {
          month: '2001-02-01',
          state: 'failed',
          verified_at: new Date(),
          dropped_at: new Date(),
        },
      ],
      [
        'dropped month marked failed',
        {
          month: '2001-02-01',
          state: 'failed',
          verified_at: new Date(),
          detached_at: new Date(),
          dropped_at: new Date(),
        },
      ],
      [
        'negative attempts',
        { month: '2001-02-01', state: 'failed', attempts: -1 },
      ],
      [
        'digest of the wrong shape',
        { month: '2001-02-01', state: 'failed', rows_digest: 'xyz' },
      ],
      [
        'chunks that are not an array',
        { month: '2001-02-01', state: 'failed', chunks: '{}' },
      ],
    ];
    for (const [label, values] of bad)
      expect(await pgError(insert(values)), label).toMatchObject({
        code: '23514',
      });
    const now = new Date();
    await insert({ month: '2001-02-01', state: 'exporting' });
    await insert({
      month: '2001-03-01',
      state: 'verified',
      verified_at: now,
      ...manifest,
    });
    await insert({
      month: '2001-04-01',
      state: 'detached',
      verified_at: now,
      detached_at: now,
      ...manifest,
    });
    await insert({
      month: '2001-05-01',
      state: 'dropped',
      verified_at: now,
      detached_at: now,
      dropped_at: now,
      ...manifest,
    });
    await insert({ month: '2001-06-01', state: 'failed', verified_at: now });
    // 一个月一行。
    expect(
      await pgError(insert({ month: '2001-02-01', state: 'exporting' })),
    ).toMatchObject({ code: '23505' });
    await db.owner.pool.query(
      `delete from raw_cdr_archives where month >= '2001-01-01' and month < '2002-01-01'`,
    );
  });

  it('is invisible and read-only to tenants and cannot be deleted by the application', async () => {
    await insert({ month: '2001-07-01', state: 'exporting' });
    const tenant = (await one<{ id: string }>(`select id from tenants limit 1`))
      .id;
    const visible = await withTenant(db.app.db, tenant, (tx) =>
      tx.execute(sql`select count(*)::int as n from raw_cdr_archives`),
    );
    expect(visible.rows).toEqual([{ n: 0 }]);
    const operatorSees = await withAdmin(db.app.db, (tx) =>
      tx.execute(sql`select count(*)::int as n from raw_cdr_archives`),
    );
    expect(operatorSees.rows[0]!.n).toBeGreaterThan(0);
    // 租户的 UPDATE 被策略过滤成 0 行；INSERT 被策略拒绝。
    expect(
      await pgError(
        withTenant(db.app.db, tenant, (tx) =>
          tx.execute(
            sql`insert into raw_cdr_archives (month, state) values ('2001-08-01', 'exporting')`,
          ),
        ),
      ),
    ).toMatchObject({ code: '42501' });
    const updated = await withTenant(db.app.db, tenant, (tx) =>
      tx.execute(sql`update raw_cdr_archives set state = 'failed'`),
    );
    expect(updated.rowCount).toBe(0);
    const deleted = await pgError(
      withAdmin(db.app.db, (tx) =>
        tx.execute(sql`delete from raw_cdr_archives`),
      ),
    );
    expect(deleted.code).toBe('42501');
    await db.owner.pool.query(
      `delete from raw_cdr_archives where month = '2001-07-01'`,
    );
  });
});

describe('锁：决定 48 与分离对入库的影响', () => {
  const timed = async <T>(run: () => Promise<T>) => {
    const started = performance.now();
    const result = await run();
    return { result, ms: performance.now() - started };
  };

  it('ensure_month_partition gives up after two seconds instead of queueing behind a long transaction', async () => {
    const reader = await db.owner.pool.connect();
    try {
      await reader.query('begin');
      await reader.query('select count(*) from raw_cdrs');
      // 应用角色没有 ensure_month_partition 的执行权限（只有 cdr_ensure_partitions），所以用 owner 连接声明系统身份来调。
      const maintenance = await db.owner.pool.connect();
      const create = timed(async () => {
        try {
          await maintenance.query('begin');
          await maintenance.query(
            `select set_config('app.scope', 'system', true)`,
          );
          return await pgError(
            maintenance.query(
              `select ensure_month_partition('raw_cdrs', '2031-05-15T00:00:00Z'::timestamptz)`,
            ),
          );
        } finally {
          await maintenance.query('rollback').catch(() => undefined);
          maintenance.release();
        }
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // 建分区的 ACCESS EXCLUSIVE 请求正在排队：后到的普通读本来会排在它后面，一直等到长事务结束。
      const laterRead = await timed(() =>
        withSystem(db.app.db, (tx) =>
          tx.execute(sql`select 1 from raw_cdrs limit 1`),
        ).then(
          () => 'ok',
          () => 'error',
        ),
      );
      const created = await create;
      expect(created.result).toMatchObject({ code: '55P03' });
      expect(created.ms).toBeGreaterThan(1800);
      expect(created.ms).toBeLessThan(4500);
      // 读在建分区放弃之后立刻通过（长事务还没结束）。
      expect(laterRead.result).toBe('ok');
      expect(laterRead.ms).toBeLessThan(2600);
      expect(
        (
          await one<{ found: boolean }>(
            `select to_regclass('raw_cdrs_2031_05') is not null as found`,
          )
        ).found,
      ).toBe(false);
    } finally {
      await reader.query('rollback').catch(() => undefined);
      reader.release();
    }
  }, 20_000);

  it('detach waits at most three seconds for a reader of the old partition and does not block ingest meanwhile', async () => {
    const { month, manifest } = await verifiedMonth(5);
    const reader = await db.owner.pool.connect();
    try {
      await reader.query('begin');
      await reader.query(`select count(*) from ${partitionOf(month)}`);
      const detach = timed(() =>
        pgError(callDetach(month, manifest.dbFingerprint)),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      // 分离函数此刻在等老分区的锁，还没碰 raw_cdrs 父表：入库的插入不受影响。
      const insert = await timed(() =>
        withSystem(db.app.db, (tx) =>
          tx.execute(
            sql`insert into raw_cdrs (body) values ('{"during":"detach wait"}')`,
          ),
        ),
      );
      expect(insert.ms).toBeLessThan(1000);
      const detached = await detach;
      expect(detached.result).toMatchObject({ code: '55P03' });
      expect(detached.ms).toBeGreaterThan(2800);
      expect(detached.ms).toBeLessThan(5000);
      expect(await attached(month)).toBe(true);
    } finally {
      await reader.query('rollback').catch(() => undefined);
      reader.release();
    }
  }, 20_000);

  it('an ingest insert stalls for at most the lock timeout while detach waits for the parent table', async () => {
    const { month, manifest } = await verifiedMonth(5);
    const current = await one<{ lo: string; hi: string }>(
      `select to_char(date_trunc('month', now() at time zone 'Asia/Shanghai'), 'YYYY-MM-DD"T"HH24:MI:SS') || '+08' as lo,
              to_char(date_trunc('month', now() at time zone 'Asia/Shanghai') + interval '1 month', 'YYYY-MM-DD"T"HH24:MI:SS') || '+08' as hi`,
    );
    const reader = await db.owner.pool.connect();
    try {
      // 一个只读当前月分区的读者（常量范围，规划时就剪掉老分区）：持有 raw_cdrs 父表的 ACCESS SHARE，不碰老分区。
      await reader.query('begin');
      await reader.query(
        `select count(*) from raw_cdrs where received_at >= '${current.lo}' and received_at < '${current.hi}'`,
      );
      const detach = timed(() =>
        pgError(callDetach(month, manifest.dbFingerprint)),
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      // DETACH 要父表的 ACCESS EXCLUSIVE，在读者后面排队，后到的插入又排在它后面：最多停到 lock_timeout。
      const insert = await timed(() =>
        withSystem(db.app.db, (tx) =>
          tx.execute(
            sql`insert into raw_cdrs (body) values ('{"during":"parent wait"}')`,
          ),
        ),
      );
      const detached = await detach;
      expect(detached.result).toMatchObject({ code: '55P03' });
      expect(detached.ms).toBeGreaterThan(2800);
      expect(insert.ms).toBeGreaterThan(1800);
      expect(insert.ms).toBeLessThan(3600);
      expect(await attached(month)).toBe(true);
    } finally {
      await reader.query('rollback').catch(() => undefined);
      reader.release();
    }
    // 读者走了，同一个月再来一次就能分离。
    await callDetach(month, manifest.dbFingerprint);
    expect(await attached(month)).toBe(false);
  }, 20_000);

  it('keeps accepting inserts at full speed while a month is detached under load', async () => {
    const { month, manifest } = await verifiedMonth(200);
    let stop = false;
    const latencies: number[] = [];
    const writers = Array.from({ length: 4 }, async () => {
      while (!stop) {
        const { ms } = await timed(() =>
          withSystem(db.app.db, (tx) =>
            tx.execute(
              sql`insert into raw_cdrs (body) values ('{"load":true}')`,
            ),
          ),
        );
        latencies.push(ms);
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await callDetach(month, manifest.dbFingerprint);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop = true;
    await Promise.all(writers);
    expect(await attached(month)).toBe(false);
    expect(latencies.length).toBeGreaterThan(20);
    // 没有任何阻塞者时，分离没有让一次插入等到 lock_timeout。
    expect(Math.max(...latencies)).toBeLessThan(2000);
  }, 30_000);
});
