import { eq, sql } from 'drizzle-orm';
import type { PoolDb, Tx } from '../client.js';
import { withSystem } from '../client.js';
import { ensureCdrPartitions } from '../partitions.js';
import { rawCdrArchives } from '../schema.js';
import { loadManifest, requireArchivedFile, stageOf } from './manifest.js';
import type { ArchiveStore } from './store.js';
import { ArchiveError, archiveFileKey, rawPartitionName } from './types.js';
import { assertArchiveFile, readArchiveLines } from './verify.js';

export interface RestoreSummary {
  month: string;
  /** reattached：宽限期内把 …_archived 原样挂回；from-file：分区已丢弃，从归档文件重建。 */
  method: 'reattached' | 'from-file';
  rows: number;
}

/** 一批 INSERT 的行数与原文字节上限。 */
const BATCH_ROWS = 500;
const BATCH_BYTES = 8 * 1024 * 1024;

const monthBounds = (month: string) =>
  sql`(${month}::date::timestamp AT TIME ZONE 'Asia/Shanghai') AS lo,
      ((${month}::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai') AS hi`;

async function partitionRows(tx: Tx, month: string): Promise<number> {
  const { rows } = await tx.execute<{ n: string }>(sql`
    WITH b AS (SELECT ${monthBounds(month)})
    SELECT count(*)::text AS n FROM raw_cdrs, b WHERE received_at >= b.lo AND received_at < b.hi`);
  return Number(rows[0]!.n);
}

/** 恢复之后清单置回 exporting：月份的数据又在 raw_cdrs 里了，restored_at 起 30 天内不再归档。 */
async function markRestored(tx: Tx, month: string): Promise<void> {
  const updated = await tx
    .update(rawCdrArchives)
    .set({
      state: 'exporting',
      restoredAt: sql`now()`,
      verifiedAt: null,
      detachedAt: null,
      droppedAt: null,
      lastError: null,
    })
    .where(eq(rawCdrArchives.month, month))
    .returning({ month: rawCdrArchives.month });
  if (updated.length === 0)
    throw new ArchiveError('清单里没有这个月', 'restore');
}

/**
 * 整月恢复（运维脚本，非验收项）：
 * - 宽限期内（清单 detached，`…_archived` 还在）：直接把它挂回 raw_cdrs，不读文件；
 * - 已丢弃（dropped）：重建分区，按归档文件逐成员校验哈希后 INSERT，保留原 id 与 received_at
 *   （payload 由生成列重新得到），再用清单里的指纹核对整个分区，不符整体回滚。
 * 分区仍挂在 raw_cdrs 下（verified 之前）则无需恢复。
 */
export async function restoreRawCdrMonth(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
): Promise<RestoreSummary> {
  const manifest = requireArchivedFile(await loadManifest(db, month), month);
  const stage = stageOf(manifest);

  if (stage === 'detached') {
    await withSystem(db, async (tx) => {
      await tx.execute(sql`select raw_cdrs_reattach_partition(${month}::date)`);
      await markRestored(tx, month);
    });
    return { month, method: 'reattached', rows: manifest.rows ?? 0 };
  }
  if (stage !== 'dropped')
    throw new ArchiveError(
      `${month.slice(0, 7)} 的分区仍在 raw_cdrs 下，无需恢复`,
      'restore',
    );

  await assertArchiveFile(store, manifest, 'restore');
  // 分区不能在持租户锁或写入的事务里建；已经存在（上次恢复中途失败留下的空分区）就复用。
  await ensureCdrPartitions(db, {
    moment: new Date(`${month}T00:00:00+08:00`),
    monthsAhead: 0,
  });
  const fingerprint = manifest.dbFingerprint;
  if (!fingerprint) throw new ArchiveError('清单里没有分区指纹', 'restore');

  let restored = 0;
  await withSystem(db, async (tx) => {
    restored = 0;
    if ((await partitionRows(tx, month)) !== 0)
      throw new ArchiveError(
        `${rawPartitionName(month)} 已经有数据，拒绝覆盖`,
        'restore',
      );
    let batch: { id: string; receivedAt: string; body: string }[] = [];
    let batchBytes = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      // 用一个 jsonb 参数传输：驱动对数组参数的转义我们不依赖；jsonb 字符串值与原文逐字相同。
      await tx.execute(sql`
        INSERT INTO raw_cdrs (id, received_at, body)
        SELECT (r ->> 'id')::uuid, (r ->> 'receivedAt')::timestamptz, r ->> 'body'
        FROM jsonb_array_elements(${JSON.stringify(batch)}::jsonb) AS r`);
      restored += batch.length;
      batch = [];
      batchBytes = 0;
    };
    for await (const line of readArchiveLines(
      store,
      archiveFileKey(month),
      manifest.chunks,
      'restore',
    )) {
      batch.push({ id: line.id, receivedAt: line.receivedAt, body: line.body });
      batchBytes += Buffer.byteLength(line.body, 'utf8');
      if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES)
        await flush();
    }
    await flush();
    if (restored !== manifest.rows)
      throw new ArchiveError(
        `恢复了 ${restored} 行，清单是 ${manifest.rows} 行`,
        'restore',
      );
    // 整个分区的指纹必须与导出时一致（行数、原文字节数、逐行哈希的异或）。
    const { rows } = await tx.execute<{
      n: string;
      bytes: string;
      xor: string;
    }>(sql`
      WITH b AS (SELECT ${monthBounds(month)})
      SELECT count(*)::text AS n, coalesce(sum(octet_length(body)), 0)::text AS bytes,
        coalesce(bit_xor(hashtextextended(id::text || body, 0)), 0)::text AS xor
      FROM raw_cdrs, b WHERE received_at >= b.lo AND received_at < b.hi`);
    const seen = rows[0]!;
    if (
      Number(seen.n) !== fingerprint.count ||
      Number(seen.bytes) !== fingerprint.bodyBytes ||
      seen.xor !== fingerprint.xor
    )
      throw new ArchiveError(
        '恢复后的分区指纹与归档时不一致，已回滚',
        'restore',
      );
    await markRestored(tx, month);
  });
  return { month, method: 'from-file', rows: restored };
}
