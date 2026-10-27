import { z } from 'zod';
import type { Db, Tx } from '../client.js';
import { bodySha256, decodeMember, sha256Hex } from './format.js';
import { loadManifest, requireArchivedFile } from './manifest.js';
import type { ArchiveStore } from './store.js';
import { ArchiveError } from './types.js';

export interface RestoredRawCdr {
  id: string;
  receivedAt: string;
  /** raw_cdrs.body 存的文本。 */
  body: string;
  /** body 的 UTF-8 字节：「逐字节相同」的对象，输出时原样写出。 */
  bytes: Buffer;
  sha256: string;
}

const RECEIVED_AT =
  /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * 把 ISO 时间规范成归档里的写法 `YYYY-MM-DDTHH:MM:SS.ffffffZ`（UTC、微秒）。
 * 接受 psql 的输出（空格分隔、`+00`）和 `+08:00` 之类的偏移；不经 Date 的毫秒精度，微秒原样保留。
 */
export function normalizeReceivedAt(input: string): string {
  const match = RECEIVED_AT.exec(input.trim());
  if (!match) throw new ArchiveError(`received_at 格式不对: ${input}`, 'read');
  const [, date, time, fraction = '', zone = 'Z'] = match;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offsetMinutes =
      (zone.startsWith('-') ? -1 : 1) *
      (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || '0'));
  }
  const seconds = Date.parse(`${date}T${time}Z`);
  if (Number.isNaN(seconds))
    throw new ArchiveError(`received_at 不是有效时间: ${input}`, 'read');
  const utc = new Date(seconds - offsetMinutes * 60_000).toISOString();
  return `${utc.slice(0, 19)}.${fraction.padEnd(6, '0')}Z`;
}

/** 归档里的 UTC 时间落在哪个北京月（该月 1 日）。北京时间没有夏令时，固定 +8 小时。 */
export function beijingMonthOf(receivedAt: string): string {
  const shifted = new Date(
    Date.parse(`${receivedAt.slice(0, 19)}Z`) + 8 * 3_600_000,
  );
  return `${shifted.toISOString().slice(0, 7)}-01`;
}

const uuid = z.uuid();

/**
 * 单条恢复（验收 5）：按 receivedAt 找月份清单和成员，只读解压相关成员（约 1000 行），
 * 按 id 取行，核对成员哈希和原文哈希，返回与归档前逐字节相同的 body。只读，不写数据库。
 * 哈希对不上就报错，不返回内容。
 */
export async function readArchivedRawCdr(
  db: Db | Tx,
  store: ArchiveStore,
  query: { id: string; receivedAt: string },
): Promise<RestoredRawCdr> {
  const id = uuid.safeParse(query.id);
  if (!id.success) throw new ArchiveError('id 不是 UUID', 'read');
  const receivedAt = normalizeReceivedAt(query.receivedAt);
  const month = beijingMonthOf(receivedAt);
  const manifest = requireArchivedFile(await loadManifest(db, month), month);

  // 成员按 received_at 升序且区间不重叠，但相同 received_at 的行可能跨两个成员，所以取所有覆盖它的成员。
  const candidates = manifest.chunks.filter(
    (chunk) =>
      chunk.firstReceivedAt <= receivedAt && receivedAt <= chunk.lastReceivedAt,
  );
  for (const chunk of candidates) {
    const bytes = await store.readRange(
      manifest.fileKey,
      chunk.offset,
      chunk.length,
    );
    if (sha256Hex(bytes) !== chunk.sha256)
      throw new ArchiveError(
        `归档成员（偏移 ${chunk.offset}）的 SHA-256 与清单不符`,
        'read',
      );
    for (const line of await decodeMember(bytes)) {
      if (line.id !== id.data || line.receivedAt !== receivedAt) continue;
      const actual = bodySha256(line.body);
      if (actual !== line.sha256)
        throw new ArchiveError(
          `归档里 ${line.id} 的原文与记录的 SHA-256 不符`,
          'read',
        );
      return {
        id: line.id,
        receivedAt: line.receivedAt,
        body: line.body,
        bytes: Buffer.from(line.body, 'utf8'),
        sha256: actual,
      };
    }
  }
  throw new ArchiveError(
    `${month.slice(0, 7)} 的归档里没有 ${id.data} @ ${receivedAt}`,
    'read',
  );
}
