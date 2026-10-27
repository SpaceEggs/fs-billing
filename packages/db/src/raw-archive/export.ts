import type { PoolDb } from '../client.js';
import { withSystem } from '../client.js';
import { exportRows } from './cursor.js';
import {
  FingerprintAccumulator,
  RowsDigest,
  bodySha256,
  compressMember,
  encodeLine,
  sha256Hex,
} from './format.js';
import type { ArchiveStore, ArchiveWriter } from './store.js';
import {
  ARCHIVE_MEMBER_MAX_BYTES,
  ARCHIVE_MEMBER_MAX_ROWS,
  ArchiveError,
  archiveFileKey,
  type ArchiveChunk,
  type ArchiveFingerprint,
} from './types.js';

/** 导出的结果：临时文件已写完并 fsync，等待校验。 */
export interface ExportedArchive {
  fileKey: string;
  rows: number;
  bodyBytes: number;
  fileBytes: number;
  fileSha256: string;
  rowsDigest: string;
  fingerprint: ArchiveFingerprint;
  chunks: ArchiveChunk[];
}

export interface ExportOptions {
  /** `.partial` 超过这么久没写入才视为陈旧、可丢弃重写。 */
  staleAfterMs?: number;
}

const snapshot = {
  isolationLevel: 'repeatable read',
  accessMode: 'read only',
} as const;

/**
 * 步骤 1：REPEATABLE READ 只读事务里按分区名读（见 raw_cdrs_export_cursor），分批写 `<key>.partial`，
 * 每 1000 行（或 4 MiB 未压缩）结束一个 gzip 成员，最后 fsync。校验通过之前数据库一行不动。
 * 事务回调可能被 withSystem 整体重跑（40001），所以每次都从新的临时文件开始、出错就丢弃。
 */
export async function exportMonthToPartial(
  db: PoolDb,
  store: ArchiveStore,
  month: string,
  options: ExportOptions = {},
): Promise<ExportedArchive> {
  const fileKey = archiveFileKey(month);
  return withSystem(
    db,
    async (tx) => {
      const held: { writer?: ArchiveWriter } = {};
      try {
        const chunks: ArchiveChunk[] = [];
        const digest = new RowsDigest();
        const fingerprint = new FingerprintAccumulator();
        let lines: Buffer[] = [];
        let memberBytes = 0;
        let firstReceivedAt = '';
        let lastReceivedAt = '';
        let rows = 0;
        let bodyBytes = 0;
        const open = async () =>
          (held.writer ??= await store.create(fileKey, {
            ...(options.staleAfterMs !== undefined && {
              staleAfterMs: options.staleAfterMs,
            }),
          }));
        const flush = async () => {
          if (lines.length === 0) return;
          const compressed = await compressMember(lines);
          const end = await (await open()).write(compressed);
          chunks.push({
            offset: end - compressed.length,
            length: compressed.length,
            sha256: sha256Hex(compressed),
            rows: lines.length,
            firstReceivedAt,
            lastReceivedAt,
          });
          lines = [];
          memberBytes = 0;
        };

        for await (const batch of exportRows(tx, month, true)) {
          for (const row of batch) {
            if (row.linked)
              throw new ArchiveError(
                `分区里有带 tenant_id 或 call_uuid 的行（${row.id}），归档格式不含这两列`,
                'export',
              );
            if (row.body === null)
              throw new ArchiveError('导出游标没有返回原文', 'export');
            if (lastReceivedAt !== '' && row.receivedAt < lastReceivedAt)
              throw new ArchiveError(
                '导出的行没有按 received_at 排序',
                'export',
              );
            // 数据库算的哈希与 JavaScript 按 UTF-8 字节重算的必须一致：驱动解码有任何变换都在这里暴露。
            const sha256 = bodySha256(row.body);
            const bytes = Buffer.byteLength(row.body, 'utf8');
            if (sha256 !== row.sha256 || bytes !== row.bodyBytes)
              throw new ArchiveError(
                `行 ${row.id} 的原文经驱动取回后与数据库里的哈希不一致`,
                'export',
              );
            const line = encodeLine({
              id: row.id,
              receivedAt: row.receivedAt,
              sha256,
              body: row.body,
            });
            if (
              lines.length > 0 &&
              (lines.length >= ARCHIVE_MEMBER_MAX_ROWS ||
                memberBytes + line.length > ARCHIVE_MEMBER_MAX_BYTES)
            )
              await flush();
            if (lines.length === 0) firstReceivedAt = row.receivedAt;
            lines.push(line);
            memberBytes += line.length;
            lastReceivedAt = row.receivedAt;
            digest.add(sha256);
            fingerprint.add(bytes, row.rowHash);
            rows += 1;
            bodyBytes += bytes;
          }
        }
        await flush();
        // 空分区也写出（空）文件，之后的校验、分离、恢复走同一条路径。
        const finished = await (await open()).finish();
        return {
          fileKey,
          rows,
          bodyBytes,
          fileBytes: finished.bytes,
          fileSha256: finished.sha256,
          rowsDigest: digest.digest(),
          fingerprint: fingerprint.result(),
          chunks,
        };
      } catch (error) {
        await held.writer?.abort();
        throw error;
      }
    },
    snapshot,
  );
}
