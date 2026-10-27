import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../client.js';
import { withSystem } from '../client.js';
import { rawCdrArchives } from '../schema.js';
import {
  ArchiveError,
  type ArchiveChunk,
  type ArchiveFingerprint,
  type ArchiveStage,
} from './types.js';

export type ArchiveManifest = typeof rawCdrArchives.$inferSelect;

/** 续作位置由时间戳决定，不看 state：failed 只表示最近一步抛了错。 */
export function stageOf(
  manifest: Pick<ArchiveManifest, 'verifiedAt' | 'detachedAt' | 'droppedAt'>,
): ArchiveStage {
  if (manifest.droppedAt) return 'dropped';
  if (manifest.detachedAt) return 'detached';
  if (manifest.verifiedAt) return 'verified';
  return 'exporting';
}

export async function loadManifest(
  db: Db | Tx,
  month: string,
): Promise<ArchiveManifest | null> {
  const [row] = await withSystem(db, (tx) =>
    tx.select().from(rawCdrArchives).where(eq(rawCdrArchives.month, month)),
  );
  return row ?? null;
}

/**
 * 开始（或续作）导出：插入 exporting；已有行且还没通过校验就置回 exporting（含上次失败的 failed）。
 * 已经 verified 及以后的行不动，返回 null——调用方按清单里的阶段继续。
 */
export async function beginExport(
  db: Db,
  month: string,
): Promise<ArchiveManifest | null> {
  const [row] = await withSystem(db, (tx) =>
    tx
      .insert(rawCdrArchives)
      .values({ month, state: 'exporting' })
      .onConflictDoUpdate({
        target: rawCdrArchives.month,
        set: { state: 'exporting' },
        setWhere: isNull(rawCdrArchives.verifiedAt),
      })
      .returning(),
  );
  return row ?? null;
}

export interface VerifiedArchive {
  fileKey: string;
  rows: number;
  bodyBytes: number;
  fileBytes: number;
  fileSha256: string;
  rowsDigest: string;
  fingerprint: ArchiveFingerprint;
  chunks: ArchiveChunk[];
}

/** 校验通过且文件已改成正式名之后记入清单；条件更新，别的任务已经完成时返回 false。 */
export async function markVerified(
  db: Db,
  month: string,
  archive: VerifiedArchive,
): Promise<boolean> {
  const updated = await withSystem(db, (tx) =>
    tx
      .update(rawCdrArchives)
      .set({
        state: 'verified',
        verifiedAt: sql`now()`,
        fileKey: archive.fileKey,
        rows: archive.rows,
        bodyBytes: archive.bodyBytes,
        fileBytes: archive.fileBytes,
        fileSha256: archive.fileSha256,
        rowsDigest: archive.rowsDigest,
        dbFingerprint: archive.fingerprint,
        chunks: archive.chunks,
        lastError: null,
      })
      .where(
        and(
          eq(rawCdrArchives.month, month),
          isNull(rawCdrArchives.verifiedAt),
          inArray(rawCdrArchives.state, ['exporting', 'failed']),
        ),
      )
      .returning({ month: rawCdrArchives.month }),
  );
  return updated.length > 0;
}

/** 记录失败：state = failed，attempts + 1，last_error（不含原文）。行还不存在就新建。 */
export async function markFailed(
  db: Db,
  month: string,
  message: string,
): Promise<void> {
  await withSystem(db, async (tx) => {
    await tx
      .insert(rawCdrArchives)
      .values({ month, state: 'failed', attempts: 1, lastError: message })
      .onConflictDoUpdate({
        target: rawCdrArchives.month,
        set: {
          state: 'failed',
          attempts: sql`${rawCdrArchives.attempts} + 1`,
          lastError: message,
        },
        setWhere: isNull(rawCdrArchives.droppedAt),
      });
  });
}

/**
 * 分离前发现分区内容与导出时不一致（导出之后又有行写进来或被改）：清单退回「需要重新导出」——
 * 去掉 verified_at，下次运行从头导出并重新校验，旧文件在新文件通过校验、改名发布时才被替换。
 */
export async function requestReexport(db: Db, month: string): Promise<void> {
  await withSystem(db, (tx) =>
    tx
      .update(rawCdrArchives)
      .set({ state: 'failed', verifiedAt: null })
      .where(
        and(
          eq(rawCdrArchives.month, month),
          isNotNull(rawCdrArchives.verifiedAt),
          isNull(rawCdrArchives.detachedAt),
        ),
      ),
  );
}

/** 分离与清单更新在同一个事务里（调用方传入）：返回是否更新到了行。 */
export async function markDetached(tx: Tx, month: string): Promise<boolean> {
  const updated = await tx
    .update(rawCdrArchives)
    .set({ state: 'detached', detachedAt: sql`now()`, lastError: null })
    .where(
      and(
        eq(rawCdrArchives.month, month),
        isNotNull(rawCdrArchives.verifiedAt),
        isNull(rawCdrArchives.detachedAt),
      ),
    )
    .returning({ month: rawCdrArchives.month });
  return updated.length > 0;
}

export async function markDropped(tx: Tx, month: string): Promise<boolean> {
  const updated = await tx
    .update(rawCdrArchives)
    .set({ state: 'dropped', droppedAt: sql`now()`, lastError: null })
    .where(
      and(
        eq(rawCdrArchives.month, month),
        isNotNull(rawCdrArchives.detachedAt),
        isNull(rawCdrArchives.droppedAt),
      ),
    )
    .returning({ month: rawCdrArchives.month });
  return updated.length > 0;
}

/** 清单里必须有已校验的归档信息，才能读文件。 */
export function requireArchivedFile(
  manifest: ArchiveManifest | null,
  month: string,
): ArchiveManifest & {
  fileKey: string;
  fileBytes: number;
  fileSha256: string;
  chunks: ArchiveChunk[];
} {
  if (
    !manifest ||
    !manifest.verifiedAt ||
    manifest.fileKey === null ||
    manifest.fileBytes === null ||
    manifest.fileSha256 === null ||
    manifest.chunks === null
  )
    throw new ArchiveError(`${month.slice(0, 7)} 没有已校验的归档`, 'read');
  return {
    ...manifest,
    fileKey: manifest.fileKey,
    fileBytes: manifest.fileBytes,
    fileSha256: manifest.fileSha256,
    chunks: manifest.chunks,
  };
}
