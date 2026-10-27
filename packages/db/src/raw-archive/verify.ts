import { createHash } from 'node:crypto';
import type { PoolDb } from '../client.js';
import { withSystem } from '../client.js';
import { exportRows } from './cursor.js';
import { RowsDigest, bodySha256, decodeMember, sha256Hex } from './format.js';
import { partialKey, type ArchiveStore } from './store.js';
import { ArchiveError, type ArchiveChunk } from './types.js';
import type { ExportedArchive } from './export.js';

const snapshot = {
  isolationLevel: 'repeatable read',
  accessMode: 'read only',
} as const;

/** 整个文件的 SHA-256（流式读取，不整体载入内存）。 */
export async function hashFile(
  store: ArchiveStore,
  key: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of store.openRead(key)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

/** 文件必须存在，长度与哈希都和清单一致；DROP 与 DETACH 之前都要过这一关。 */
export async function assertArchiveFile(
  store: ArchiveStore,
  file: { fileKey: string; fileBytes: number; fileSha256: string },
  step: 'detach' | 'drop' | 'verify' | 'restore',
): Promise<void> {
  const stat = await store.stat(file.fileKey);
  if (!stat) throw new ArchiveError(`归档文件 ${file.fileKey} 不存在`, step);
  if (stat.bytes !== file.fileBytes)
    throw new ArchiveError(
      `归档文件 ${file.fileKey} 的长度（${stat.bytes}）与清单（${file.fileBytes}）不符`,
      step,
    );
  const actual = await hashFile(store, file.fileKey);
  if (actual.sha256 !== file.fileSha256)
    throw new ArchiveError(
      `归档文件 ${file.fileKey} 的 SHA-256 与清单不符`,
      step,
    );
}

/** 按清单顺序逐成员读出所有行：先验成员的压缩字节哈希，再解压、逐行重算原文哈希。 */
export async function* readArchiveLines(
  store: ArchiveStore,
  key: string,
  chunks: readonly ArchiveChunk[],
  step: 'verify' | 'restore' | 'read' = 'read',
) {
  for (const [index, chunk] of chunks.entries()) {
    const bytes = await store.readRange(key, chunk.offset, chunk.length);
    if (sha256Hex(bytes) !== chunk.sha256)
      throw new ArchiveError(
        `归档成员 ${index + 1} 的 SHA-256 与清单不符`,
        step,
      );
    const lines = await decodeMember(bytes);
    if (lines.length !== chunk.rows)
      throw new ArchiveError(`归档成员 ${index + 1} 的行数与清单不符`, step);
    for (const line of lines) {
      if (bodySha256(line.body) !== line.sha256)
        throw new ArchiveError(
          `归档行 ${line.id} 的原文与记录的 SHA-256 不符`,
          step,
        );
      yield line;
    }
  }
}

/**
 * 步骤 2：重新打开 `.partial`，逐成员解压、逐行重算 sha256(body)，与导出时的逐行哈希和数据库当前的
 * sha256(convert_to(body, 'UTF8')) 逐行比较（另开一个快照事务，只传哈希不传原文）；行数与 rows_digest 一致才通过。
 */
export async function verifyPartial(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  exported: ExportedArchive,
): Promise<void> {
  const key = partialKey(exported.fileKey);
  const written = await hashFile(store, key);
  if (
    written.bytes !== exported.fileBytes ||
    written.sha256 !== exported.fileSha256
  )
    throw new ArchiveError('临时文件的长度或哈希与写入时记录的不符', 'verify');

  await withSystem(
    db,
    async (tx) => {
      const lines = readArchiveLines(store, key, exported.chunks, 'verify');
      const digest = new RowsDigest();
      let rows = 0;
      for await (const batch of exportRows(tx, month, false)) {
        for (const row of batch) {
          const next = await lines.next();
          if (next.done)
            throw new ArchiveError(
              `数据库里的行 ${row.id} 在归档文件中找不到`,
              'verify',
            );
          const line = next.value;
          if (
            line.id !== row.id ||
            line.receivedAt !== row.receivedAt ||
            line.sha256 !== row.sha256 ||
            Buffer.byteLength(line.body, 'utf8') !== row.bodyBytes
          )
            throw new ArchiveError(
              `第 ${rows + 1} 行（${row.id}）与数据库不一致`,
              'verify',
            );
          digest.add(line.sha256);
          rows += 1;
        }
      }
      if (!(await lines.next()).done)
        throw new ArchiveError('归档文件的行数多于数据库', 'verify');
      if (rows !== exported.rows)
        throw new ArchiveError(
          `校验读到 ${rows} 行，导出时是 ${exported.rows} 行`,
          'verify',
        );
      if (digest.digest() !== exported.rowsDigest)
        throw new ArchiveError('rows_digest 与导出时不一致', 'verify');
    },
    snapshot,
  );
}
