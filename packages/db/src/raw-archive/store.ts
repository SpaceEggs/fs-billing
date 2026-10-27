import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { ARCHIVE_PARTIAL_STALE_MS, ArchiveBusyError } from './types.js';

/** 一个正在写的归档文件（`<key>.partial`）。 */
export interface ArchiveWriter {
  /** 按顺序追加字节，返回写入后的文件长度。 */
  write(bytes: Uint8Array): Promise<number>;
  /** fsync 并关闭，返回文件长度与整体 SHA-256。 */
  finish(): Promise<{ bytes: number; sha256: string }>;
  /** 出错时关闭并删除临时文件。 */
  abort(): Promise<void>;
}

/**
 * 归档文件的存储。本阶段只有本地目录一种实现；以后加对象存储只需实现这个接口，调用方不动。
 * key 是相对存储根的路径（如 `raw-cdrs/2026/raw-cdrs-2026-03.jsonl.gz`），临时文件的 key 是 `partialKey(key)`。
 */
export interface ArchiveStore {
  /**
   * 新建 `<key>.partial`。已存在时：超过 `staleAfterMs` 没有写入的视为上次崩溃遗留，丢弃重写；
   * 否则抛 ArchiveBusyError（另一个任务正在写）。
   */
  create(
    key: string,
    options?: { staleAfterMs?: number },
  ): Promise<ArchiveWriter>;
  /** 把 `<key>.partial` 原子地改成正式文件。 */
  publish(key: string): Promise<void>;
  /** 读 [offset, offset + length) 字节，文件不够长就报错。 */
  readRange(key: string, offset: number, length: number): Promise<Buffer>;
  /** 整个文件的字节流。 */
  openRead(key: string): AsyncIterable<Buffer>;
  /** 文件长度；不存在返回 null。 */
  stat(key: string): Promise<{ bytes: number } | null>;
  /** 删除文件（不存在不报错）。 */
  remove(key: string): Promise<void>;
}

export const partialKey = (key: string) => `${key}.partial`;

const KEY_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const isMissing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';
const isExisting = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'EEXIST';

/** 本地目录存储：文件 0600、目录 0700，写入后 fsync，发布时 rename 并 fsync 目录。 */
export class LocalArchiveStore implements ArchiveStore {
  constructor(readonly root: string) {
    if (!isAbsolute(root)) throw new Error('归档目录必须是绝对路径');
  }

  private path(key: string): string {
    if (!KEY_PATTERN.test(key) || key.split('/').includes('..'))
      throw new Error(`非法的归档文件 key: ${key}`);
    return join(this.root, key);
  }

  async create(
    key: string,
    { staleAfterMs = ARCHIVE_PARTIAL_STALE_MS }: { staleAfterMs?: number } = {},
  ): Promise<ArchiveWriter> {
    const file = this.path(partialKey(key));
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    let handle;
    for (let attempt = 0; ; attempt++) {
      try {
        // wx：文件已存在就失败，两个任务不会写同一个临时文件。
        handle = await open(file, 'wx', 0o600);
        break;
      } catch (error) {
        if (!isExisting(error) || attempt > 0) throw error;
        const existing = await stat(file).catch((statError: unknown) => {
          if (isMissing(statError)) return null;
          throw statError;
        });
        if (existing && Date.now() - existing.mtimeMs <= staleAfterMs)
          throw new ArchiveBusyError(key);
        await unlink(file).catch((unlinkError: unknown) => {
          if (!isMissing(unlinkError)) throw unlinkError;
        });
      }
    }
    const hash = createHash('sha256');
    let bytes = 0;
    let closed = false;
    return {
      async write(chunk) {
        let written = 0;
        while (written < chunk.byteLength) {
          const { bytesWritten } = await handle.write(
            chunk,
            written,
            chunk.byteLength - written,
          );
          written += bytesWritten;
        }
        hash.update(chunk);
        bytes += chunk.byteLength;
        return bytes;
      },
      async finish() {
        await handle.sync();
        await handle.close();
        closed = true;
        return { bytes, sha256: hash.digest('hex') };
      },
      async abort() {
        if (!closed) await handle.close().catch(() => undefined);
        closed = true;
        await unlink(file).catch((error: unknown) => {
          if (!isMissing(error)) throw error;
        });
      },
    };
  }

  async publish(key: string): Promise<void> {
    const final = this.path(key);
    await rename(this.path(partialKey(key)), final);
    // 目录项也要落盘，否则断电后改名可能丢。
    const directory = await open(dirname(final), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
  ): Promise<Buffer> {
    const handle = await open(this.path(key), 'r');
    try {
      const buffer = Buffer.alloc(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          length - filled,
          offset + filled,
        );
        if (bytesRead === 0) throw new Error(`归档文件 ${key} 比清单记录的短`);
        filled += bytesRead;
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  openRead(key: string): AsyncIterable<Buffer> {
    return createReadStream(this.path(key));
  }

  async stat(key: string): Promise<{ bytes: number } | null> {
    try {
      return { bytes: (await stat(this.path(key))).size };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    await unlink(this.path(key)).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
  }
}
