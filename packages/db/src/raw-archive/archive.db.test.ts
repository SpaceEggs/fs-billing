import { randomUUID } from 'node:crypto';
import { readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deferred } from '../../test/support.js';
import { scratchDatabase } from '../../test/scratch.js';
import {
  bodyBytesBefore,
  fixtureId,
  monthDigest,
  seedRawMonth,
  temporaryStore,
  trickyBodies,
  type RawFixtureRow,
} from '../../test/raw-archive.js';
import { compressMember, encodeLine, sha256Hex } from './format.js';
import { loadManifest } from './manifest.js';
import { readArchivedRawCdr } from './read.js';
import { restoreRawCdrMonth } from './restore.js';
import {
  archiveMonth,
  dropMonth,
  planRawArchive,
  runRawArchive,
  type ArchiveCheckpoint,
  type ArchiveOptions,
} from './run.js';
import { exportMonthToPartial } from './export.js';
import { partialKey } from './store.js';
import { ArchiveBusyError, ArchiveError, archiveFileKey } from './types.js';

const db = scratchDatabase({ seed: false });
const archive = temporaryStore();
const options: ArchiveOptions = { afterMonths: 6, graceDays: 7 };
const DAY = 86_400_000;

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
const exists = async (name: string) =>
  (
    await one<{ found: boolean }>(
      'select to_regclass($1) is not null as found',
      [name],
    )
  ).found;
const isAttached = async (month: string) =>
  (
    await one<{ found: boolean }>(
      `select exists (select from pg_inherits where inhrelid = to_regclass($1)
         and inhparent = 'raw_cdrs'::regclass) as found`,
      [partitionOf(month)],
    )
  ).found;

/** 2020 年的月份：早于任何「现在」减 7 个月。每个测试各用一个月，互不干扰。 */
let monthCounter = 0;
function newMonth(): string {
  monthCounter += 1;
  const year = 2010 + Math.floor((monthCounter - 1) / 12);
  return `${year}-${String(((monthCounter - 1) % 12) + 1).padStart(2, '0')}-01`;
}

/** 清掉其他测试留下的老分区和清单，让「最老的未完成月」只可能是当前测试的月份。 */
async function cleanSlate() {
  const parts = await query<{ relname: string }>(
    `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where i.inhparent = 'raw_cdrs'::regclass and c.relname ~ '^raw_cdrs_(20[01]\\d|202[0-4])_\\d\\d$'`,
  );
  for (const { relname } of parts)
    await db.owner.pool.query(`drop table ${relname}`);
  const archived = await query<{ relname: string }>(
    `select relname from pg_class where relname ~ '^raw_cdrs_20\\d\\d_\\d\\d_archived$'`,
  );
  for (const { relname } of archived)
    await db.owner.pool.query(`drop table ${relname}`);
  await db.owner.pool.query('delete from raw_cdr_archives');
}

/** 一个月的数据：前几行是各种难处理的原文，其余是普通行；998 至 1002 号行共用一个时间，跨在两个成员的边界上。 */
function monthRows(month: string, count: number): RawFixtureRow[] {
  const tricky = trickyBodies();
  const base = Date.parse(`${month.slice(0, 7)}-14T00:00:00Z`);
  const rows: RawFixtureRow[] = [];
  for (let n = 0; n < count; n++) {
    const body =
      n < tricky.length
        ? tricky[n]!.body
        : `{"n":${n},"variables":{"uuid":"${randomUUID()}"}}\n`;
    const slot = n >= 998 && n <= 1002 ? 998 : n;
    const fraction = slot % 1000 === 7 ? 456 : 0;
    const stamp = new Date(base + slot * 1000 + 123);
    rows.push({
      id: fixtureId(n + 1),
      receivedAt: `${stamp.toISOString().slice(0, 19).replace('T', ' ')}.${String(stamp.getUTCMilliseconds()).padStart(3, '0')}${String(fraction).padStart(3, '0')}+00`,
      body,
    });
  }
  return rows;
}

async function seedMonth(
  count: number,
): Promise<{ month: string; rows: RawFixtureRow[] }> {
  const month = newMonth();
  const rows = monthRows(month, count);
  await seedRawMonth(db.app, db.owner, month, rows);
  return { month, rows };
}

/** 故障注入的错误：失败记录里只留错误名，不留消息，所以用名字区分。 */
class InjectedFailure extends Error {
  override name = 'InjectedFailure';
}

/** 抛出指定检查点的故障注入。 */
const failAt = (point: ArchiveCheckpoint) => (reached: ArchiveCheckpoint) => {
  if (reached === point) throw new InjectedFailure(`注入故障 @ ${point}`);
};

describe('原始 JSON 归档与恢复（验收 5）', () => {
  it('restores a single raw cdr byte for byte after the partition is dropped', async () => {
    const { month, rows } = await seedMonth(2305);
    const before = await bodyBytesBefore(db.owner, month);
    expect(before.size).toBe(rows.length);
    const digestBefore = await monthDigest(db.owner, month);

    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
    const manifest = (await loadManifest(db.app.db, month))!;
    expect(manifest).toMatchObject({
      state: 'detached',
      rows: rows.length,
      attempts: 0,
      lastError: null,
    });
    expect(manifest.chunks!.length).toBeGreaterThanOrEqual(3);
    // 微秒不丢：第 8 行（序号 7）的 received_at 以 456 微秒结尾。
    expect(before.get(fixtureId(8))!.receivedAt).toMatch(/\.123456Z$/);
    expect(await isAttached(month)).toBe(false);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);

    // 宽限期之后丢弃：分区与 _archived 表都没了，数据库里已经没有这个月的原文，只剩文件。
    const dropAt = new Date(manifest.detachedAt!.getTime() + 7 * DAY + 1);
    await cleanSlateExcept(month);
    const summary = await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf: dropAt,
    });
    expect(summary).toMatchObject({ dropped: [month], failures: [] });
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(false);
    expect(await exists(partitionOf(month))).toBe(false);
    expect((await monthDigest(db.owner, month)).n).toBe(0);

    // 每一行都逐字节相同：难处理的原文、成员边界、相同时间的行全取，其余抽样（整月恢复再比较整月摘要）。
    const ordered = [...before.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    const picked = ordered.filter(
      (_, index) =>
        index < 12 ||
        (index >= 990 && index <= 1010) ||
        index >= ordered.length - 3 ||
        index % 97 === 0,
    );
    for (const [id, original] of picked) {
      const restored = await readArchivedRawCdr(db.app.db, archive.store, {
        id,
        receivedAt: original.receivedAt,
      });
      expect(restored.bytes.toString('hex'), id).toBe(original.hex);
      expect(restored.sha256).toBe(sha256Hex(restored.bytes));
    }
    // 带偏移量的写法（psql 的输出）也能定位到同一行。
    const sample = ordered[7]!;
    const viaPsql = await readArchivedRawCdr(db.app.db, archive.store, {
      id: sample[0],
      receivedAt: sample[1].receivedAt.replace('T', ' ').replace('Z', '+00'),
    });
    expect(viaPsql.bytes.toString('hex')).toBe(sample[1].hex);

    const restoredMonth = await restoreRawCdrMonth(
      db.app.db,
      archive.store,
      month,
    );
    expect(restoredMonth).toMatchObject({
      method: 'from-file',
      rows: rows.length,
    });
    expect(await monthDigest(db.owner, month)).toEqual(digestBefore);
  });

  it('finds a row whose received_at is shared with rows in the neighbouring member', async () => {
    const { month } = await seedMonth(1100);
    const before = await bodyBytesBefore(db.owner, month);
    await archiveMonth(db.app.db, archive.store, month, options);
    const manifest = (await loadManifest(db.app.db, month))!;
    // 998 至 1002 号行同一时间，第 1000 行起是第二个成员。
    const tied = [...before.entries()].filter(([id]) => {
      const n = Number.parseInt(id.slice(-12), 16);
      return n >= 999 && n <= 1003;
    });
    expect(new Set(tied.map(([, row]) => row.receivedAt)).size).toBe(1);
    expect(manifest.chunks!.length).toBe(2);
    expect(manifest.chunks![0]!.lastReceivedAt).toBe(
      manifest.chunks![1]!.firstReceivedAt,
    );
    for (const [id, original] of tied) {
      const restored = await readArchivedRawCdr(db.app.db, archive.store, {
        id,
        receivedAt: original.receivedAt,
      });
      expect(restored.bytes.toString('hex')).toBe(original.hex);
    }
  });

  it('refuses to return a body whose hash does not match', async () => {
    const { month } = await seedMonth(40);
    const before = await bodyBytesBefore(db.owner, month);
    await archiveMonth(db.app.db, archive.store, month, options);
    const manifest = (await loadManifest(db.app.db, month))!;
    const path = join(archive.dir, archiveFileKey(month));
    const [target, original] = [...before.entries()][5]!;
    const ask = () =>
      readArchivedRawCdr(db.app.db, archive.store, {
        id: target,
        receivedAt: original.receivedAt,
      });
    expect((await ask()).bytes.toString('hex')).toBe(original.hex);

    // 1. 压缩字节被改：成员哈希与清单不符。
    const intact = await readFile(path);
    const damaged = Buffer.from(intact);
    damaged[Math.floor(damaged.length / 2)]! ^= 0xff;
    await writeFile(path, damaged);
    await expect(ask()).rejects.toThrow('SHA-256 与清单不符');

    // 2. 连清单里的成员哈希也一起改（文件整体被换成另一份）：行里记录的原文哈希仍然对不上，不返回内容。
    const lines = (await import('./format.js')).decodeMember;
    const decoded = await lines(intact.subarray(manifest.chunks![0]!.offset));
    const forged = decoded.map((line) =>
      line.id === target ? { ...line, body: `${line.body}伪造` } : line,
    );
    const member = await compressMember(forged.map(encodeLine));
    await writeFile(path, member);
    await db.owner.pool.query(
      `update raw_cdr_archives set chunks = $2::jsonb, file_bytes = $3, file_sha256 = $4 where month = $1`,
      [
        month,
        JSON.stringify([
          {
            ...manifest.chunks![0]!,
            offset: 0,
            length: member.length,
            sha256: sha256Hex(member),
          },
        ]),
        member.length,
        sha256Hex(member),
      ],
    );
    const failure = await ask().then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(ArchiveError);
    expect(failure!.message).toContain('原文与记录的 SHA-256 不符');
    expect(failure!.message).not.toContain('伪造');

    // 3. 不存在的行、没有归档的月份、缺失的文件都是明确的错误。
    await writeFile(path, intact);
    await db.owner.pool.query(
      `update raw_cdr_archives set chunks = $2::jsonb, file_bytes = $3, file_sha256 = $4 where month = $1`,
      [
        month,
        JSON.stringify(manifest.chunks),
        manifest.fileBytes,
        manifest.fileSha256,
      ],
    );
    await expect(
      readArchivedRawCdr(db.app.db, archive.store, {
        id: randomUUID(),
        receivedAt: original.receivedAt,
      }),
    ).rejects.toThrow('归档里没有');
    await expect(
      readArchivedRawCdr(db.app.db, archive.store, {
        id: target,
        receivedAt: '2001-02-03T04:05:06.000000Z',
      }),
    ).rejects.toThrow('没有已校验的归档');
    await rm(path);
    await expect(ask()).rejects.toThrow();
    await writeFile(path, intact);
    expect((await ask()).bytes.toString('hex')).toBe(original.hex);
  });

  it('restores a whole month with the same ids, times and bodies', async () => {
    const { month, rows } = await seedMonth(1200);
    const digestBefore = await monthDigest(db.owner, month);
    await archiveMonth(db.app.db, archive.store, month, options);
    const detachedAt = (await loadManifest(db.app.db, month))!.detachedAt!;
    await cleanSlateExcept(month);
    await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf: new Date(detachedAt.getTime() + 8 * DAY),
    });
    expect((await loadManifest(db.app.db, month))!.state).toBe('dropped');

    const restored = await restoreRawCdrMonth(db.app.db, archive.store, month);
    expect(restored).toEqual({ month, method: 'from-file', rows: rows.length });
    // id、received_at（含微秒）、body 以及由生成列重新得到的 payload 都相同。
    expect(await monthDigest(db.owner, month)).toEqual(digestBefore);
    expect(await isAttached(month)).toBe(true);
    const manifest = (await loadManifest(db.app.db, month))!;
    expect(manifest).toMatchObject({
      state: 'exporting',
      verifiedAt: null,
      detachedAt: null,
      droppedAt: null,
    });
    expect(manifest.restoredAt).toBeInstanceOf(Date);

    // 已有数据时拒绝再恢复；恢复后 30 天内不再归档，30 天后才重新进入归档。
    await db.owner.pool.query(
      `update raw_cdr_archives set state = 'dropped', verified_at = now(), detached_at = now(), dropped_at = now() where month = $1`,
      [month],
    );
    await expect(
      restoreRawCdrMonth(db.app.db, archive.store, month),
    ).rejects.toThrow('已经有数据');
    await db.owner.pool.query(
      `update raw_cdr_archives set state = 'exporting', verified_at = null, detached_at = null, dropped_at = null where month = $1`,
      [month],
    );
    expect((await planRawArchive(db.app.db, options)).next).toBeNull();
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          asOf: new Date(manifest.restoredAt!.getTime() + 29 * DAY),
        })
      ).next,
    ).toBeNull();
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          asOf: new Date(manifest.restoredAt!.getTime() + 30 * DAY + 1),
        })
      ).next,
    ).toBe(month);
  });

  it('rolls a whole-month restore back when the file no longer matches the recorded fingerprint', async () => {
    const { month } = await seedMonth(30);
    await archiveMonth(db.app.db, archive.store, month, options);
    const detachedAt = (await loadManifest(db.app.db, month))!.detachedAt!;
    await cleanSlateExcept(month);
    await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf: new Date(detachedAt.getTime() + 8 * DAY),
    });
    await db.owner.pool.query(
      `update raw_cdr_archives set db_fingerprint = jsonb_set(db_fingerprint, '{xor}', '"123"') where month = $1`,
      [month],
    );
    await expect(
      restoreRawCdrMonth(db.app.db, archive.store, month),
    ).rejects.toThrow('指纹与归档时不一致');
    // 整体回滚：分区是空的（已重建），清单仍是 dropped，之后修好清单可以再来一次。
    expect((await monthDigest(db.owner, month)).n).toBe(0);
    expect((await loadManifest(db.app.db, month))!.state).toBe('dropped');
  });

  it('restores a month inside the grace period by attaching the detached table again', async () => {
    const { month, rows } = await seedMonth(50);
    const digestBefore = await monthDigest(db.owner, month);
    await archiveMonth(db.app.db, archive.store, month, options);
    expect(await isAttached(month)).toBe(false);
    // 宽限期内不需要归档文件：删掉它也能挂回。
    await rm(join(archive.dir, archiveFileKey(month)));
    expect(await restoreRawCdrMonth(db.app.db, archive.store, month)).toEqual({
      month,
      method: 'reattached',
      rows: rows.length,
    });
    expect(await isAttached(month)).toBe(true);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(false);
    expect(await monthDigest(db.owner, month)).toEqual(digestBefore);
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'exporting',
      detachedAt: null,
    });
    // 主键索引名也回到分区名下。
    expect(
      (
        await one<{ n: number }>(
          `select count(*)::int as n from pg_class where relname = $1`,
          [`${partitionOf(month)}_pkey`],
        )
      ).n,
    ).toBe(1);
    // 没有可恢复的东西（分区仍挂着）：明确拒绝。
    await expect(
      restoreRawCdrMonth(db.app.db, archive.store, month),
    ).rejects.toThrow('没有已校验的归档');
  });
});

/** 其他月份清掉，只保留 `keep` 的分区与清单，让 runRawArchive 的计划只含这个月。 */
async function cleanSlateExcept(keep: string) {
  const parts = await query<{ relname: string }>(
    `select c.relname from pg_inherits i join pg_class c on c.oid = i.inhrelid
     where i.inhparent = 'raw_cdrs'::regclass and c.relname ~ '^raw_cdrs_(20[01]\\d|202[0-4])_\\d\\d$' and c.relname <> $1`,
    [partitionOf(keep)],
  );
  for (const { relname } of parts)
    await db.owner.pool.query(`drop table ${relname}`);
  const archived = await query<{ relname: string }>(
    `select relname from pg_class where relname ~ '^raw_cdrs_20\\d\\d_\\d\\d_archived$' and relname <> $1`,
    [`${partitionOf(keep)}_archived`],
  );
  for (const { relname } of archived)
    await db.owner.pool.query(`drop table ${relname}`);
  await db.owner.pool.query('delete from raw_cdr_archives where month <> $1', [
    keep,
  ]);
}

describe('归档的时间与对象', () => {
  it('archives only months whose end plus six months has passed', async () => {
    await cleanSlate();
    const dates = ['2024-03-01', '2024-04-01'];
    for (const month of dates)
      await seedRawMonth(db.app, db.owner, month, monthRows(month, 3));
    // 2024-03 的月末是 04-01 00:00，加 6 个月是 2024-10-01 00:00（北京）。
    const justBefore = new Date('2024-10-01T00:00:00+08:00').getTime() - 1;
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          asOf: new Date(justBefore),
        })
      ).next,
    ).toBeNull();
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          asOf: new Date(justBefore + 1),
        })
      ).next,
    ).toBe('2024-03-01');
    // 4 月份要再等一个月。
    const plan = await planRawArchive(db.app.db, {
      ...options,
      asOf: new Date('2024-10-31T23:59:59+08:00'),
    });
    expect(plan.next).toBe('2024-03-01');
    await archiveMonth(db.app.db, archive.store, '2024-03-01', options);
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          asOf: new Date('2024-10-31T23:59:59+08:00'),
        })
      ).next,
    ).toBeNull();
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          asOf: new Date('2024-11-01T00:00:00+08:00'),
        })
      ).next,
    ).toBe('2024-04-01');
    // afterMonths 可配置。
    expect(
      (
        await planRawArchive(db.app.db, {
          afterMonths: 1,
          graceDays: 7,
          asOf: new Date('2024-06-01T00:00:00+08:00'),
        })
      ).next,
    ).toBe('2024-04-01');
    await cleanSlate();
  });

  it('archives the oldest unfinished month first, one month per run', async () => {
    await cleanSlate();
    for (const month of ['2023-02-01', '2023-01-01', '2023-03-01'])
      await seedRawMonth(db.app, db.owner, month, monthRows(month, 3));
    const first = await runRawArchive(db.app.db, archive.store, options);
    expect(first.advanced).toEqual({ month: '2023-01-01', stage: 'detached' });
    const second = await runRawArchive(db.app.db, archive.store, options);
    expect(second.advanced).toEqual({ month: '2023-02-01', stage: 'detached' });
    expect(await isAttached('2023-03-01')).toBe(true);
    await cleanSlate();
  });

  it('archives an empty partition and restores nothing from it', async () => {
    await cleanSlate();
    const month = newMonth();
    await seedRawMonth(db.app, db.owner, month, []);
    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
    const manifest = (await loadManifest(db.app.db, month))!;
    expect(manifest).toMatchObject({
      rows: 0,
      bodyBytes: 0,
      fileBytes: 0,
      chunks: [],
    });
    expect(
      (await readFile(join(archive.dir, archiveFileKey(month)))).length,
    ).toBe(0);
    await cleanSlateExcept(month);
    const dropped = await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf: new Date(manifest.detachedAt!.getTime() + 8 * DAY),
    });
    expect(dropped.dropped).toEqual([month]);
    await expect(
      restoreRawCdrMonth(db.app.db, archive.store, month),
    ).resolves.toMatchObject({ rows: 0 });
    await cleanSlate();
  });

  it('keeps the detached table during the grace period and drops it afterwards', async () => {
    await cleanSlate();
    const { month } = await seedMonth(20);
    await archiveMonth(db.app.db, archive.store, month, options);
    const { detachedAt } = (await loadManifest(db.app.db, month))!;
    const at = (ms: number) => ({
      ...options,
      asOf: new Date(detachedAt!.getTime() + ms),
    });
    // 精确到毫秒：detached_at 有微秒，JavaScript 的 Date 截成毫秒，所以「差一毫秒」才算过了宽限期。
    const early = await runRawArchive(
      db.app.db,
      archive.store,
      at(7 * DAY - 1000),
    );
    expect(early.dropped).toEqual([]);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);
    expect(
      (await planRawArchive(db.app.db, at(7 * DAY - 1000))).dropDue,
    ).toEqual([]);
    expect((await planRawArchive(db.app.db, at(7 * DAY + 1))).dropDue).toEqual([
      month,
    ]);
    const late = await runRawArchive(db.app.db, archive.store, at(7 * DAY + 1));
    expect(late.dropped).toEqual([month]);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(false);
    expect(await loadManifest(db.app.db, month)).toMatchObject({
      state: 'dropped',
    });
    // 再来一次：什么都不做。
    expect(
      await runRawArchive(db.app.db, archive.store, at(30 * DAY)),
    ).toMatchObject({ dropped: [], advanced: null, failures: [] });
    // 宽限天数可配置：0 天即分离后立刻可以丢弃。
    const { month: next } = await seedMonth(5);
    await archiveMonth(db.app.db, archive.store, next, options);
    const detached = (await loadManifest(db.app.db, next))!.detachedAt!;
    expect(
      (
        await planRawArchive(db.app.db, {
          ...options,
          graceDays: 0,
          asOf: new Date(detached.getTime() + 1),
        })
      ).dropDue,
    ).toEqual([next]);
    await cleanSlate();
  });

  it('reports a manifest that disagrees with the partitions without touching them', async () => {
    await cleanSlate();
    const { month } = await seedMonth(3);
    await db.owner.pool.query(
      `insert into raw_cdr_archives (month, state, verified_at, detached_at, file_key, rows, body_bytes, file_bytes, file_sha256, rows_digest, db_fingerprint, chunks)
       values ($1, 'detached', now(), now(), 'x/y', 0, 0, 0, repeat('a', 64), repeat('b', 64), '{}', '[]')`,
      [month],
    );
    const plan = await planRawArchive(db.app.db, options);
    expect(plan.next).toBeNull();
    expect(plan.inconsistent).toEqual([
      { month, reason: '清单记着已分离，分区却仍挂在 raw_cdrs 下' },
    ]);
    expect(await isAttached(month)).toBe(true);
    await cleanSlate();
  });
});

describe('崩溃与续作', () => {
  it('a crash after export and before detach is resumed', async () => {
    await cleanSlate();
    const { month } = await seedMonth(1500);
    // 进程在导出写完之后、校验之前被杀：清单停在 exporting，留下一份写完的临时文件。
    await db.owner.pool.query(
      `insert into raw_cdr_archives (month, state) values ($1, 'exporting')`,
      [month],
    );
    const abandoned = await exportMonthToPartial(
      db.app.db,
      archive.store,
      month,
    );
    const partial = join(archive.dir, partialKey(abandoned.fileKey));
    // 临时文件还新（另一个任务可能正在写）时拒绝接手；过了陈旧期限才丢弃重写。
    await expect(
      archiveMonth(db.app.db, archive.store, month, options),
    ).rejects.toBeInstanceOf(ArchiveBusyError);
    const stale = new Date(Date.now() - 3_600_000);
    await utimes(partial, stale, stale);
    // 数据库一行没动：分区还在，清单还没有 verified。
    expect(await isAttached(month)).toBe(true);
    expect((await loadManifest(db.app.db, month))!.verifiedAt).toBeNull();

    expect(
      await archiveMonth(db.app.db, archive.store, month, {
        ...options,
        staleAfterMs: 60_000,
      }),
    ).toBe('detached');
    expect(await isAttached(month)).toBe(false);
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'detached',
      rows: 1500,
      attempts: 0,
    });
    expect(await archive.store.stat(partialKey(abandoned.fileKey))).toBeNull();
    await cleanSlate();
  });

  it('a crash after the file is published and before the manifest says verified is resumed', async () => {
    const { month } = await seedMonth(30);
    await expect(
      archiveMonth(db.app.db, archive.store, month, {
        ...options,
        onCheckpoint: failAt('published'),
      }),
    ).rejects.toThrow('InjectedFailure');
    // 正式文件已经在，清单还是失败状态，分区没动。
    expect(await archive.store.stat(archiveFileKey(month))).not.toBeNull();
    expect(await isAttached(month)).toBe(true);
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'failed',
      verifiedAt: null,
      attempts: 1,
    });
    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'detached',
      attempts: 1,
      lastError: null,
    });
  });

  it('a failure after the manifest says verified continues with the detach instead of exporting again', async () => {
    const { month } = await seedMonth(30);
    // 先完成导出与清单，再人为在分离前失败：清单是 verified（时间戳为准），重来时直接分离。
    await archiveMonth(db.app.db, archive.store, month, {
      ...options,
      onCheckpoint: (point) => {
        if (point === 'detach-in-transaction')
          throw new InjectedFailure('注入故障 @ detach');
      },
    }).catch(() => undefined);
    const afterFailure = (await loadManifest(db.app.db, month))!;
    expect(afterFailure.state).toBe('failed');
    expect(afterFailure.verifiedAt).toBeInstanceOf(Date);
    expect(afterFailure.detachedAt).toBeNull();
    // DDL 与清单更新在同一个事务里：事务回滚，分区仍然挂着。
    expect(await isAttached(month)).toBe(true);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(false);
    const fileBefore = await readFile(join(archive.dir, archiveFileKey(month)));

    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
    // 没有重新导出：文件字节与清单里的校验时间都没变。
    expect(
      (await readFile(join(archive.dir, archiveFileKey(month)))).equals(
        fileBefore,
      ),
    ).toBe(true);
    expect((await loadManifest(db.app.db, month))!.verifiedAt).toEqual(
      afterFailure.verifiedAt,
    );
    expect(await isAttached(month)).toBe(false);
  });

  it('a failure right after the manifest is written does not count as a failed export', async () => {
    const { month } = await seedMonth(10);
    await archiveMonth(db.app.db, archive.store, month, {
      ...options,
      onCheckpoint: failAt('marked'),
    }).catch(() => undefined);
    const manifest = (await loadManifest(db.app.db, month))!;
    expect(manifest).toMatchObject({ state: 'verified', attempts: 0 });
    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
  });

  it('a crash between detach and drop waits for the grace period and then drops', async () => {
    await cleanSlate();
    const { month } = await seedMonth(10);
    await archiveMonth(db.app.db, archive.store, month, options);
    // 进程在宽限期里重启：什么都不会提前丢。
    const restartedEarly = await runRawArchive(
      db.app.db,
      archive.store,
      options,
    );
    expect(restartedEarly).toMatchObject({ dropped: [], failures: [] });
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);
    const { detachedAt } = (await loadManifest(db.app.db, month))!;
    const asOf = new Date(detachedAt!.getTime() + 7 * DAY + 1);
    await expect(
      dropMonth(db.app.db, archive.store, month, {
        onCheckpoint: failAt('drop-in-transaction'),
      }),
    ).rejects.toThrow('InjectedFailure');
    // 丢弃事务回滚：表还在，清单仍是已分离（失败标记）。
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'failed',
      droppedAt: null,
    });
    const summary = await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf,
    });
    expect(summary).toMatchObject({ dropped: [month], failures: [] });
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(false);
    await cleanSlate();
  });
});

describe('校验不过就不分离', () => {
  it('a corrupted partial file blocks the detach and is thrown away', async () => {
    const { month } = await seedMonth(60);
    const key = archiveFileKey(month);
    await expect(
      archiveMonth(db.app.db, archive.store, month, {
        ...options,
        onCheckpoint: async (point) => {
          if (point !== 'exported') return;
          const path = join(archive.dir, partialKey(key));
          const bytes = await readFile(path);
          bytes[bytes.length - 12]! ^= 0x01;
          await writeFile(path, bytes);
        },
      }),
    ).rejects.toThrow();
    // 数据库一行没动，没有正式文件，临时文件已丢弃，失败记入清单。
    expect(await isAttached(month)).toBe(true);
    expect(await archive.store.stat(key)).toBeNull();
    expect(await archive.store.stat(partialKey(key))).toBeNull();
    const manifest = (await loadManifest(db.app.db, month))!;
    expect(manifest).toMatchObject({
      state: 'failed',
      verifiedAt: null,
      detachedAt: null,
      attempts: 1,
    });
    expect(manifest.lastError).toMatch(/^verify: /);
    // 修好之后（不再损坏）从头再来，成功。
    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'detached',
      lastError: null,
      attempts: 1,
    });
  });

  it('a row that changes between the export and the verification blocks the detach', async () => {
    const { month } = await seedMonth(25);
    await expect(
      archiveMonth(db.app.db, archive.store, month, {
        ...options,
        onCheckpoint: async (point) => {
          if (point !== 'exported') return;
          await db.owner.pool.query(
            `insert into raw_cdrs (id, received_at, body) values ($1, $2, '{"late":true}')`,
            [randomUUID(), `${month.slice(0, 7)}-20 00:00:00+00`],
          );
        },
      }),
    ).rejects.toThrow('在归档文件中找不到');
    expect(await isAttached(month)).toBe(true);
    expect(await archive.store.stat(archiveFileKey(month))).toBeNull();
    expect((await loadManifest(db.app.db, month))!.state).toBe('failed');
    // 再来一次：新行被一起导出，校验通过。
    await archiveMonth(db.app.db, archive.store, month, options);
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'detached',
      rows: 26,
    });
  });

  it('a row written after the verification is caught by the database before it detaches, and the month is exported again', async () => {
    const { month } = await seedMonth(25);
    // 校验与清单更新之间写进一行：清单记着旧指纹，分离函数重算后发现不符，拒绝分离。
    let injected = false;
    const archiveWithLateRow = () =>
      archiveMonth(db.app.db, archive.store, month, {
        ...options,
        onCheckpoint: async (point) => {
          if (point !== 'published' || injected) return;
          injected = true;
          await db.owner.pool.query(
            `insert into raw_cdrs (id, received_at, body) values ($1, $2, '{"too":"late"}')`,
            [randomUUID(), `${month.slice(0, 7)}-21 00:00:00+00`],
          );
        },
      });
    await expect(archiveWithLateRow()).rejects.toThrow('内容与导出时不一致');
    expect(await isAttached(month)).toBe(true);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(false);
    // 退回重新导出：verified_at 清掉，下次运行从头导出，新行一起进文件。
    const afterFailure = (await loadManifest(db.app.db, month))!;
    expect(afterFailure).toMatchObject({
      state: 'failed',
      verifiedAt: null,
      attempts: 1,
    });
    expect(await archiveMonth(db.app.db, archive.store, month, options)).toBe(
      'detached',
    );
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'detached',
      rows: 26,
      lastError: null,
    });
  });

  it('refuses a partition with rows linked to a tenant or a call, which the file format cannot hold', async () => {
    const { month } = await seedMonth(5);
    await db.owner.pool.query(
      `update raw_cdrs set call_uuid = $2 where id = $1`,
      [fixtureId(2), randomUUID()],
    );
    await expect(
      archiveMonth(db.app.db, archive.store, month, options),
    ).rejects.toThrow('归档格式不含这两列');
    expect(await isAttached(month)).toBe(true);
    expect(await archive.store.stat(archiveFileKey(month))).toBeNull();
    expect(
      await archive.store.stat(partialKey(archiveFileKey(month))),
    ).toBeNull();
  });

  it('a lost or damaged archive file blocks the drop and the detached table stays', async () => {
    await cleanSlate();
    const { month } = await seedMonth(15);
    await archiveMonth(db.app.db, archive.store, month, options);
    const { detachedAt } = (await loadManifest(db.app.db, month))!;
    const asOf = new Date(detachedAt!.getTime() + 8 * DAY);
    const path = join(archive.dir, archiveFileKey(month));
    const intact = await readFile(path);

    await rm(path);
    const lost = await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf,
    });
    expect(lost.dropped).toEqual([]);
    expect(lost.failures).toEqual([
      {
        month,
        step: 'drop',
        message: expect.stringContaining('不存在') as string,
      },
    ]);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'failed',
      droppedAt: null,
      attempts: 1,
    });

    const damaged = Buffer.from(intact);
    damaged[damaged.length - 3]! ^= 0x10;
    await writeFile(path, damaged);
    const broken = await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf,
    });
    expect(broken.failures).toEqual([
      {
        month,
        step: 'drop',
        message: expect.stringContaining('SHA-256 与清单不符') as string,
      },
    ]);
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);

    await writeFile(path, intact);
    const fixed = await runRawArchive(db.app.db, archive.store, {
      ...options,
      asOf,
    });
    expect(fixed).toMatchObject({ dropped: [month], failures: [] });
    expect((await loadManifest(db.app.db, month))!).toMatchObject({
      state: 'dropped',
      lastError: null,
      attempts: 2,
    });
    await cleanSlate();
  });

  it('a failure records the step, a short message and no raw content', async () => {
    const { month } = await seedMonth(8);
    const secret = '+8613800138000-secret';
    await db.owner.pool.query(`update raw_cdrs set body = $2 where id = $1`, [
      fixtureId(3),
      `{"callee":"${secret}"}`,
    ]);
    await expect(
      archiveMonth(db.app.db, archive.store, month, {
        ...options,
        onCheckpoint: () => {
          throw new SyntaxError(`Unexpected token in JSON ${secret}`);
        },
      }),
    ).rejects.toThrow();
    const manifest = (await loadManifest(db.app.db, month))!;
    expect(manifest.lastError).toBe('verify: SyntaxError');
    expect(manifest.lastError).not.toContain(secret);
    await cleanSlateExcept(month);
  });
});

describe('重复触发与并发', () => {
  it('a duplicate archive job does not archive twice', async () => {
    await cleanSlate();
    const { month } = await seedMonth(40);
    const paused = deferred();
    const reached = deferred();
    const first = runRawArchive(db.app.db, archive.store, {
      ...options,
      onCheckpoint: async (point) => {
        if (point !== 'exported') return;
        reached.resolve();
        await paused.promise;
      },
    });
    await reached.promise;
    // 第一个任务的临时文件还新：第二个任务发现有人在写，本次跳过，既不失败也不重复导出。
    const second = await runRawArchive(db.app.db, archive.store, options);
    expect(second).toMatchObject({ busy: month, advanced: null, failures: [] });
    expect((await loadManifest(db.app.db, month))!.attempts).toBe(0);
    paused.resolve();
    expect(await first).toMatchObject({
      advanced: { month, stage: 'detached' },
      failures: [],
    });
    // 第三次触发：已经分离，没有可做的事。
    expect(
      await runRawArchive(db.app.db, archive.store, options),
    ).toMatchObject({ advanced: null, busy: null, failures: [] });
    expect(
      (
        await query(
          'select table_name from information_schema.tables where table_name like $1',
          [`${partitionOf(month)}%`],
        )
      ).map((row) => row.table_name),
    ).toEqual([`${partitionOf(month)}_archived`]);
    await cleanSlate();
  });

  it('two runs racing for the detach end in one consistent state without a failure', async () => {
    await cleanSlate();
    const { month } = await seedMonth(40);
    await archiveMonth(db.app.db, archive.store, month, {
      ...options,
      onCheckpoint: failAt('detach-in-transaction'),
    }).catch(() => undefined);
    expect((await loadManifest(db.app.db, month))!.verifiedAt).toBeInstanceOf(
      Date,
    );
    const results = await Promise.all([
      archiveMonth(db.app.db, archive.store, month, options),
      archiveMonth(db.app.db, archive.store, month, options),
    ]);
    expect(results).toEqual(['detached', 'detached']);
    const manifest = (await loadManifest(db.app.db, month))!;
    // 失败计数只有注入的那一次：输掉竞争的一方不算失败。
    expect(manifest).toMatchObject({ state: 'detached', attempts: 1 });
    expect(await exists(`${partitionOf(month)}_archived`)).toBe(true);
    expect(await isAttached(month)).toBe(false);
    await cleanSlate();
  });
});
