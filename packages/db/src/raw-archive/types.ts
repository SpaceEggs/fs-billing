import { z } from 'zod';

/** 每个 gzip 成员最多这么多行……  */
export const ARCHIVE_MEMBER_MAX_ROWS = 1000;
/** ……或这么多未压缩字节（一行本身更大时，成员只含这一行）。 */
export const ARCHIVE_MEMBER_MAX_BYTES = 4 * 1024 * 1024;
/** 整月恢复之后这么多天内不再归档该月。 */
export const ARCHIVE_RESTORE_HOLD_DAYS = 30;
/** 超过这个时间没有写入的 `.partial` 视为上次崩溃遗留，可以丢弃重写。 */
export const ARCHIVE_PARTIAL_STALE_MS = 15 * 60 * 1000;

/** 归档文件里的一行（JSON Lines）：键的顺序固定。 */
export interface ArchiveLine {
  id: string;
  receivedAt: string;
  sha256: string;
  body: string;
}

export const archiveLineSchema = z.strictObject({
  id: z.uuid(),
  receivedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  body: z.string(),
});

/** 一个 gzip 成员在文件里的位置与内容摘要。 */
export const archiveChunkSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  /** 压缩字节的 SHA-256。 */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  rows: z.number().int().positive(),
  firstReceivedAt: z.string(),
  lastReceivedAt: z.string(),
});
export type ArchiveChunk = z.infer<typeof archiveChunkSchema>;

/** 分区内容的指纹：行数、原文字节数（octet_length）、bit_xor(hashtextextended(id::text || body, 0))。 */
export const archiveFingerprintSchema = z.strictObject({
  count: z.number().int().nonnegative(),
  bodyBytes: z.number().int().nonnegative(),
  /** 64 位有符号整数，超出 JavaScript 安全整数范围，所以用十进制字符串。 */
  xor: z.string().regex(/^-?\d{1,19}$/),
});
export type ArchiveFingerprint = z.infer<typeof archiveFingerprintSchema>;

export const archiveStates = [
  'exporting',
  'verified',
  'detached',
  'dropped',
  'failed',
] as const;
export type ArchiveState = (typeof archiveStates)[number];

/** 续作位置：由时间戳决定，不看 state（failed 只表示最近一步抛了错）。 */
export type ArchiveStage = 'exporting' | 'verified' | 'detached' | 'dropped';

export type ArchiveStep = 'export' | 'verify' | 'detach' | 'drop';

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly step: ArchiveStep | 'restore' | 'read',
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ArchiveError';
  }
}

/** 另一个任务正在写同一个月的临时文件：本次不处理，不是失败。 */
export class ArchiveBusyError extends Error {
  constructor(readonly key: string) {
    super(`归档文件 ${key} 正由另一个任务写入`);
    this.name = 'ArchiveBusyError';
  }
}

/** 北京月（该月 1 日，YYYY-MM-01）。 */
export const archiveMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])-01$/);

/** `2026-03-01` → `raw-cdrs/2026/raw-cdrs-2026-03.jsonl.gz`。 */
export function archiveFileKey(month: string): string {
  archiveMonthSchema.parse(month);
  return `raw-cdrs/${month.slice(0, 4)}/raw-cdrs-${month.slice(0, 7)}.jsonl.gz`;
}

/** `2026-03-01` → `raw_cdrs_2026_03`。 */
export function rawPartitionName(month: string): string {
  archiveMonthSchema.parse(month);
  return `raw_cdrs_${month.slice(0, 4)}_${month.slice(5, 7)}`;
}
