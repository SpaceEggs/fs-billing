import type {} from '../../../packages/db/test/global-setup.js';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  archiveFileKey,
  archiveMonth,
  ensureCdrPartitions,
  loadManifest,
  planRawArchive,
  runRawArchive,
  type ArchiveCheckpoint,
  type ArchiveOptions,
} from '@fs-billing/db';
import { scratchDatabase } from '../../../packages/db/test/scratch.js';
import {
  bodyBytesBefore,
  fixtureId,
  seedRawMonth,
  temporaryStore,
  trickyBodies,
} from '../../../packages/db/test/raw-archive.js';
import { PgBoss } from 'pg-boss';
import {
  ARCHIVE_CRON,
  ARCHIVE_TIMEZONE,
  runRawArchiveJob,
  startRawArchive,
  syncArchiveAlerts,
} from './archive.js';
import { ARCHIVE_QUEUE, createBoss, installQueue } from './queue.js';
import { runRestoreMonth, runRestoreSingle } from './raw-restore.js';

const run = promisify(execFile);
const db = scratchDatabase({ seed: false });
const archive = temporaryStore();
const options: ArchiveOptions = { afterMonths: 6, graceDays: 7 };
const DAY = 86_400_000;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let boss: PgBoss;

beforeAll(async () => {
  await installQueue(db.owner);
  boss = createBoss(db.app.db);
  await boss.start();
});
afterAll(async () => {
  await boss.unschedule(ARCHIVE_QUEUE).catch(() => {});
  await boss.stop();
});

const query = async <T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
) => (await db.owner.pool.query<T>(text, values)).rows;
const partitionOf = (month: string) =>
  `raw_cdrs_${month.slice(0, 4)}_${month.slice(5, 7)}`;
const attached = async (month: string) =>
  (
    await query<{ found: boolean }>(
      `select exists (select from pg_inherits where inhrelid = to_regclass($1)
         and inhparent = 'raw_cdrs'::regclass) as found`,
      [partitionOf(month)],
    )
  )[0]!.found;
const alerts = () =>
  query<{
    description: string;
    recovered_at: Date | null;
    affected_calls: number;
  }>(
    `select description, recovered_at, affected_calls from system_alerts
     where kind = 'raw_archive_failed' order by started_at, description`,
  );

class InjectedFailure extends Error {
  override name = 'InjectedFailure';
}
const failAt = (point: ArchiveCheckpoint) => (reached: ArchiveCheckpoint) => {
  if (reached === point) throw new InjectedFailure(`注入故障 @ ${point}`);
};
const rows = (month: string, n: number) =>
  Array.from({ length: n }, (_, index) => ({
    id: fixtureId(index + 1),
    receivedAt: `${month.slice(0, 7)}-10 08:00:${String(index).padStart(2, '0')}.000321+00`,
    body: trickyBodies()[index % trickyBodies().length]!.body,
  }));
async function reset() {
  for (const { relname } of await query<{ relname: string }>(
    `select relname from pg_class where relname ~ '^raw_cdrs_(20[01]\\d|202[0-4])_\\d\\d(_archived)?$'`,
  ))
    await db.owner.pool.query(`drop table ${relname}`);
  await db.owner.pool.query('delete from raw_cdr_archives');
  await db.owner.pool.query('delete from system_alerts');
  await db.owner.pool.query('delete from pgboss.job where name = $1', [
    ARCHIVE_QUEUE,
  ]);
}

describe('归档任务', () => {
  it('registers a daily 04:00 Beijing schedule and allows only one queued or active job at a time', async () => {
    // 先不启动工作者：连发两次，第二次被 exclusive 策略挡下。
    await reset();
    const first = await boss.send(ARCHIVE_QUEUE);
    const second = await boss.send(ARCHIVE_QUEUE);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const queue = await boss.getQueue(ARCHIVE_QUEUE);
    expect(queue).toMatchObject({
      policy: 'exclusive',
      retryLimit: 3,
      expireInSeconds: 21600,
    });
    await startRawArchive(boss, db.app.db, archive.store, options, log);
    expect(await boss.getSchedules(ARCHIVE_QUEUE)).toMatchObject([
      { cron: ARCHIVE_CRON, timezone: ARCHIVE_TIMEZONE },
    ]);
    expect(ARCHIVE_CRON).toBe('0 4 * * *');
    // 让刚才排队的任务由工作者跑完（此时没有可归档的月份），再清空。
    await expect
      .poll(
        async () =>
          (
            await query<{ state: string }>(
              'select state from pgboss.job where id = $1',
              [first],
            )
          )[0]?.state,
        { timeout: 15_000 },
      )
      .toBe('completed');
    await reset();
  }, 30_000);

  it('the scheduled job archives a month older than six months and leaves a younger one alone', async () => {
    await reset();
    const old = '2022-01-01';
    await seedRawMonth(db.app, db.owner, old, rows(old, 12));
    // 上个月（北京）：不满 6 个月，不能动。
    const { rows: recent } = await db.owner.pool.query<{ month: string }>(
      `select to_char(date_trunc('month', now() at time zone 'Asia/Shanghai') - interval '1 month', 'YYYY-MM-DD') as month`,
    );
    const young = recent[0]!.month;
    await ensureCdrPartitions(db.app.db, {
      moment: new Date(`${young}T12:00:00+08:00`),
      monthsAhead: 0,
    });
    await seedRawMonth(db.app, db.owner, young, rows(young, 3));

    const id = await boss.send(ARCHIVE_QUEUE);
    expect(id).not.toBeNull();
    await expect
      .poll(
        async () =>
          (
            await query<{ state: string }>(
              'select state from pgboss.job where id = $1',
              [id],
            )
          )[0]?.state,
        { timeout: 20_000 },
      )
      .toBe('completed');
    expect(await loadManifest(db.app.db, old)).toMatchObject({
      state: 'detached',
      rows: 12,
    });
    expect(await attached(old)).toBe(false);
    expect(await attached(young)).toBe(true);
    expect(await loadManifest(db.app.db, young)).toBeNull();
    expect(await alerts()).toEqual([]);
    await reset();
  }, 40_000);

  it('a crash after export and before detach is resumed', async () => {
    await reset();
    const month = '2022-02-01';
    await seedRawMonth(db.app, db.owner, month, rows(month, 30));
    // 第一次运行在导出之后失败：任务抛出（pg-boss 会重试），清单 failed，开一条告警，分区没动。
    await expect(
      runRawArchiveJob(
        db.app.db,
        archive.store,
        { ...options, onCheckpoint: failAt('exported') },
        log,
      ),
    ).rejects.toThrow('原始话单归档失败: 2022-02（verify）');
    expect(await attached(month)).toBe(true);
    expect(await loadManifest(db.app.db, month)).toMatchObject({
      state: 'failed',
      attempts: 1,
      verifiedAt: null,
    });
    let open = await alerts();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ recovered_at: null, affected_calls: 0 });
    expect(open[0]!.description).toBe(
      '原始话单归档 2022-02 失败（verify）：InjectedFailure',
    );

    // 重试：接着做完，告警恢复。
    const summary = await runRawArchiveJob(
      db.app.db,
      archive.store,
      options,
      log,
    );
    expect(summary).toMatchObject({
      advanced: { month, stage: 'detached' },
      failures: [],
    });
    expect(await attached(month)).toBe(false);
    open = await alerts();
    expect(open).toHaveLength(1);
    expect(open[0]!.recovered_at).toBeInstanceOf(Date);
    await reset();
  });

  it('keeps one open alert per failing month, updates it on a repeated failure and recovers it after success', async () => {
    await reset();
    const [a, b] = ['2022-03-01', '2022-04-01'] as const;
    await seedRawMonth(db.app, db.owner, a, rows(a, 5));
    await seedRawMonth(db.app, db.owner, b, rows(b, 5));
    for (const point of ['exported', 'published'] as const)
      await expect(
        runRawArchiveJob(
          db.app.db,
          archive.store,
          { ...options, onCheckpoint: failAt(point) },
          log,
        ),
      ).rejects.toThrow('2022-03');
    // 最老的月份失败两次：仍然只有一条未恢复的告警，描述是最近一次的原因。
    let list = await alerts();
    expect(list).toHaveLength(1);
    expect(list[0]!.description).toBe(
      '原始话单归档 2022-03 失败（verify）：InjectedFailure',
    );
    expect(await loadManifest(db.app.db, a)).toMatchObject({ attempts: 2 });
    await runRawArchiveJob(db.app.db, archive.store, options, log);
    await runRawArchiveJob(db.app.db, archive.store, options, log);
    list = await alerts();
    expect(list).toHaveLength(1);
    expect(list[0]!.recovered_at).toBeInstanceOf(Date);
    expect(await attached(b)).toBe(false);
    // 之后同一个月不再失败，没有新告警。
    expect((await alerts()).filter((row) => row.recovered_at === null)).toEqual(
      [],
    );
    await reset();
  });

  it('opens an alert, without retrying, for a manifest that disagrees with the partitions and recovers dropped months', async () => {
    await reset();
    const month = '2022-05-01';
    await seedRawMonth(db.app, db.owner, month, rows(month, 2));
    await db.owner.pool.query(
      `insert into raw_cdr_archives (month, state, verified_at, detached_at, file_key, rows, body_bytes, file_bytes, file_sha256, rows_digest, db_fingerprint, chunks)
       values ($1, 'detached', now(), now(), 'x/y', 0, 0, 0, repeat('a', 64), repeat('b', 64), '{}', '[]')`,
      [month],
    );
    const summary = await runRawArchiveJob(
      db.app.db,
      archive.store,
      options,
      log,
    );
    expect(summary.inconsistent).toHaveLength(1);
    expect(await attached(month)).toBe(true);
    expect((await alerts())[0]!.description).toBe(
      '原始话单归档 2022-05 状态矛盾：清单记着已分离，分区却仍挂在 raw_cdrs 下',
    );

    // 一条已丢弃月份的残留告警，下一次运行时恢复。
    await db.owner.pool.query('delete from raw_cdr_archives');
    await db.owner.pool.query(
      `insert into raw_cdr_archives (month, state, verified_at, detached_at, dropped_at, file_key, rows, body_bytes, file_bytes, file_sha256, rows_digest, db_fingerprint, chunks)
       values ('2022-06-01', 'dropped', now(), now(), now(), 'x/y', 0, 0, 0, repeat('a', 64), repeat('b', 64), '{}', '[]')`,
    );
    await db.owner.pool.query(
      `insert into system_alerts (kind, description) values ('raw_archive_failed', '原始话单归档 2022-06 失败（drop）：x')`,
    );
    await syncArchiveAlerts(db.app.db, {
      advanced: null,
      dropped: [],
      busy: null,
      failures: [],
      inconsistent: [],
    });
    const list = await alerts();
    expect(
      list.find((row) => row.description.includes('2022-06'))!.recovered_at,
    ).toBeInstanceOf(Date);
    expect(
      list.find((row) => row.description.includes('2022-05'))!.recovered_at,
    ).toBeNull();
    await reset();
  });
});

describe('读取与恢复命令', () => {
  const capture = () => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    return {
      io: {
        stdout: new Writable({
          write: (chunk: Buffer, _e, done) => (out.push(chunk), done()),
        }),
        stderr: new Writable({
          write: (chunk: Buffer, _e, done) => (err.push(chunk), done()),
        }),
      },
      stdout: () => Buffer.concat(out),
      stderr: () => Buffer.concat(err).toString('utf8'),
    };
  };
  const environment = () => ({
    APP_DATABASE_URL: (
      db.app.pool as unknown as { options: { connectionString: string } }
    ).options.connectionString,
    RAW_CDR_ARCHIVE_DIR: archive.dir,
  });

  it('prints the stored body byte for byte, without a trailing newline, from the archive alone', async () => {
    await reset();
    const month = '2022-07-01';
    const fixture = rows(month, 10);
    await seedRawMonth(db.app, db.owner, month, fixture);
    const before = await bodyBytesBefore(db.owner, month);
    await archiveMonth(db.app.db, archive.store, month, options);
    const detachedAt = (await loadManifest(db.app.db, month))!.detachedAt!;
    await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf: new Date(detachedAt.getTime() + 8 * DAY),
    });
    expect(await attached(month)).toBe(false);

    for (const [id, original] of before) {
      const out = capture();
      const code = await runRestoreSingle(
        // pnpm 会把一个 `--` 原样传给脚本。
        ['--', '--id', id, '--received-at', original.receivedAt],
        environment(),
        out.io,
      );
      expect({ id, code, stderr: out.stderr() }).toEqual({
        id,
        code: 0,
        stderr: '',
      });
      expect(out.stdout().toString('hex'), id).toBe(original.hex);
    }
    // 真正的脚本：标准输出里的字节与原文相同（含非 ASCII、CRLF），--out 写文件，不覆盖已有文件。
    const [id, original] = [...before.entries()].find(
      ([, row]) => row.hex.length > 100 && /e4/i.test(row.hex),
    )!;
    const script = fileURLToPath(
      new URL('../scripts/restore-raw-cdr.ts', import.meta.url),
    );
    const result = await run(
      process.execPath,
      [
        '--import',
        'tsx',
        script,
        '--id',
        id,
        '--received-at',
        original.receivedAt,
      ],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, ...environment() },
        encoding: 'buffer',
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    expect(result.stdout.toString('hex')).toBe(original.hex);
    const file = join(archive.dir, 'out.json');
    const written = await runRestoreSingle(
      ['--id', id, '--received-at', original.receivedAt, '--out', file],
      environment(),
      capture().io,
    );
    expect(written).toBe(0);
    expect((await readFile(file)).toString('hex')).toBe(original.hex);
    const again = capture();
    expect(
      await runRestoreSingle(
        ['--id', id, '--received-at', original.receivedAt, '--out', file],
        environment(),
        again.io,
      ),
    ).toBe(1);
    await rm(file);
  }, 60_000);

  it('prints nothing and fails when the hash does not match, the row is missing or the arguments are wrong', async () => {
    await reset();
    const month = '2022-08-01';
    await seedRawMonth(db.app, db.owner, month, rows(month, 4));
    const before = await bodyBytesBefore(db.owner, month);
    await archiveMonth(db.app.db, archive.store, month, options);
    const [id, original] = [...before.entries()][1]!;
    const path = join(archive.dir, archiveFileKey(month));
    const intact = await readFile(path);
    const damaged = Buffer.from(intact);
    damaged[Math.floor(damaged.length / 2)]! ^= 0xff;
    await (await import('node:fs/promises')).writeFile(path, damaged);

    const corrupt = capture();
    expect(
      await runRestoreSingle(
        ['--id', id, '--received-at', original.receivedAt],
        environment(),
        corrupt.io,
      ),
    ).toBe(1);
    expect(corrupt.stdout()).toHaveLength(0);
    expect(corrupt.stderr()).toContain('恢复失败');
    expect(corrupt.stderr()).toContain('SHA-256');
    await (await import('node:fs/promises')).writeFile(path, intact);

    const missing = capture();
    expect(
      await runRestoreSingle(
        ['--id', randomUUID(), '--received-at', original.receivedAt],
        environment(),
        missing.io,
      ),
    ).toBe(1);
    expect(missing.stdout()).toHaveLength(0);
    for (const argv of [
      [],
      ['--id', id],
      ['--received-at', original.receivedAt],
      ['--bogus'],
    ]) {
      const usage = capture();
      expect(
        await runRestoreSingle(argv, environment(), usage.io),
        argv.join(' '),
      ).toBe(2);
      expect(usage.stdout()).toHaveLength(0);
    }
    const noConfig = capture();
    expect(
      await runRestoreSingle(
        ['--id', id, '--received-at', original.receivedAt],
        { APP_DATABASE_URL: environment().APP_DATABASE_URL },
        noConfig.io,
      ),
    ).toBe(2);
    expect(noConfig.stderr()).toContain('RAW_CDR_ARCHIVE_DIR');
    await reset();
  }, 30_000);

  it('restores a whole month from the command and reports a dry run', async () => {
    await reset();
    const month = '2022-09-01';
    await seedRawMonth(db.app, db.owner, month, rows(month, 25));
    await archiveMonth(db.app.db, archive.store, month, options);
    const detachedAt = (await loadManifest(db.app.db, month))!.detachedAt!;
    await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf: new Date(detachedAt.getTime() + 8 * DAY),
    });
    const dry = capture();
    expect(
      await runRestoreMonth(
        ['--', '--month', '2022-09', '--dry-run'],
        environment(),
        dry.io,
      ),
    ).toBe(0);
    expect(dry.stdout().toString()).toContain('dropped，25 行');
    expect(await attached(month)).toBe(false);
    const real = capture();
    expect(
      await runRestoreMonth(['--month', '2022-09'], environment(), real.io),
    ).toBe(0);
    expect(real.stdout().toString()).toContain('从归档文件重建');
    expect(await attached(month)).toBe(true);
    expect((await planRawArchive(db.app.db, options)).next).toBeNull();
    const again = capture();
    expect(
      await runRestoreMonth(['--month', '2022-09'], environment(), again.io),
    ).toBe(1);
    const bad = capture();
    expect(
      await runRestoreMonth(['--month', '2022-13'], environment(), bad.io),
    ).toBe(2);
    await reset();
  }, 30_000);
});
