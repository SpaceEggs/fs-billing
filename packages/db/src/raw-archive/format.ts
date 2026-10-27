import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  ARCHIVE_MEMBER_MAX_BYTES,
  ArchiveError,
  archiveLineSchema,
  type ArchiveFingerprint,
  type ArchiveLine,
} from './types.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** 解压后的成员上限：远大于写入时的 4 MiB（一行转义后可能更大），只防损坏文件的解压炸弹。 */
const MEMBER_INFLATE_LIMIT = 16 * ARCHIVE_MEMBER_MAX_BYTES;

export const sha256Hex = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

/** 原文 UTF-8 字节的 SHA-256：数据库 sha256(convert_to(body, 'UTF8')) 的 JavaScript 对应。 */
export const bodySha256 = (body: string): string =>
  sha256Hex(Buffer.from(body, 'utf8'));

/** 一行 JSON Lines：键序固定，JSON 字符串转义对任何合法 Unicode 文本无损。 */
export function encodeLine(line: ArchiveLine): Buffer {
  return Buffer.from(
    `${JSON.stringify({
      id: line.id,
      receivedAt: line.receivedAt,
      sha256: line.sha256,
      body: line.body,
    })}\n`,
    'utf8',
  );
}

/** 一个 gzip 成员；异步压缩，不在事件循环上阻塞（Worker 同进程还要处理话单推送）。 */
export function compressMember(lines: readonly Buffer[]): Promise<Buffer> {
  return gzipAsync(Buffer.concat(lines));
}

/** 解压并解析一个成员。错误信息不含原文，也不含解析器给出的片段。 */
export async function decodeMember(bytes: Uint8Array): Promise<ArchiveLine[]> {
  let text: string;
  try {
    text = (
      await gunzipAsync(bytes, { maxOutputLength: MEMBER_INFLATE_LIMIT })
    ).toString('utf8');
  } catch {
    throw new ArchiveError('归档成员无法解压', 'read');
  }
  const lines: ArchiveLine[] = [];
  const rows = text.split('\n');
  if (rows.pop() !== '') throw new ArchiveError('归档成员缺少行结束符', 'read');
  for (const [index, row] of rows.entries()) {
    let parsed;
    try {
      parsed = archiveLineSchema.safeParse(JSON.parse(row));
    } catch {
      throw new ArchiveError(`归档成员第 ${index + 1} 行不是合法 JSON`, 'read');
    }
    if (!parsed.success)
      throw new ArchiveError(`归档成员第 ${index + 1} 行格式不符`, 'read');
    lines.push(parsed.data);
  }
  return lines;
}

/** 逐行 SHA-256（32 字节）按文件顺序拼接，再取 SHA-256。 */
export class RowsDigest {
  private readonly hash = createHash('sha256');
  add(rowSha256: string): void {
    this.hash.update(Buffer.from(rowSha256, 'hex'));
  }
  digest(): string {
    return this.hash.digest('hex');
  }
}

/** 分区指纹的 JavaScript 累加器，与数据库侧 count / sum(octet_length) / bit_xor(hashtextextended) 对应。 */
export class FingerprintAccumulator {
  private count = 0;
  private bodyBytes = 0;
  private xor = 0n;
  add(bodyBytes: number, rowHash: string): void {
    this.count += 1;
    this.bodyBytes += bodyBytes;
    this.xor = BigInt.asIntN(64, this.xor ^ BigInt(rowHash));
  }
  result(): ArchiveFingerprint {
    return {
      count: this.count,
      bodyBytes: this.bodyBytes,
      xor: this.xor.toString(),
    };
  }
}
