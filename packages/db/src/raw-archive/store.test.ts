import { mkdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTemporaryDir } from '../../test/raw-archive.js';
import { LocalArchiveStore, partialKey } from './store.js';
import { ArchiveBusyError } from './types.js';
import { rm } from 'node:fs/promises';

let dir: string;
let store: LocalArchiveStore;
beforeEach(async () => {
  dir = await makeTemporaryDir();
  store = new LocalArchiveStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const KEY = 'raw-cdrs/2026/raw-cdrs-2026-03.jsonl.gz';

describe('LocalArchiveStore', () => {
  it('requires an absolute root', () => {
    expect(() => new LocalArchiveStore('relative/dir')).toThrow('绝对路径');
    expect(() => new LocalArchiveStore(tmpdir())).not.toThrow();
  });

  it.each([
    '../escape',
    'a/../b',
    '/etc/passwd',
    'a//b',
    '',
    '.hidden',
    'a/.hidden',
    'with space',
    'a\\b',
    'raw\u0000cdrs',
  ])('rejects the key %j', async (key) => {
    await expect(store.create(key)).rejects.toThrow('非法的归档文件 key');
    await expect(store.stat(key)).rejects.toThrow('非法的归档文件 key');
    await expect(store.readRange(key, 0, 1)).rejects.toThrow(
      '非法的归档文件 key',
    );
  });

  it('writes a partial file, publishes it atomically and reads ranges back', async () => {
    const writer = await store.create(KEY);
    expect(await writer.write(Buffer.from('hello '))).toBe(6);
    expect(await writer.write(Buffer.from('world'))).toBe(11);
    expect(await store.stat(KEY)).toBeNull();
    const finished = await writer.finish();
    expect(finished.bytes).toBe(11);
    expect(finished.sha256).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
    expect(await store.stat(partialKey(KEY))).toEqual({ bytes: 11 });
    await store.publish(KEY);
    expect(await store.stat(partialKey(KEY))).toBeNull();
    expect(await store.stat(KEY)).toEqual({ bytes: 11 });
    expect((await store.readRange(KEY, 6, 5)).toString()).toBe('world');
    await expect(store.readRange(KEY, 8, 10)).rejects.toThrow('比清单记录的短');
    const chunks: Buffer[] = [];
    for await (const chunk of store.openRead(KEY)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('hello world');
    // 目录 0700、文件 0600：归档里是通话记录。
    expect((await stat(join(dir, 'raw-cdrs'))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, KEY))).mode & 0o777).toBe(0o600);
  });

  it('refuses a second writer while the partial file is fresh and replaces a stale one', async () => {
    const first = await store.create(KEY);
    await first.write(Buffer.from('first'));
    await expect(store.create(KEY)).rejects.toBeInstanceOf(ArchiveBusyError);
    // 超过陈旧期限没有写入：视为上次崩溃遗留，丢弃重写。
    const path = join(dir, partialKey(KEY));
    const old = new Date(Date.now() - 3_600_000);
    await utimes(path, old, old);
    const second = await store.create(KEY, { staleAfterMs: 60_000 });
    await second.write(Buffer.from('second'));
    await second.finish();
    await store.publish(KEY);
    expect((await readFile(join(dir, KEY))).toString()).toBe('second');
    await first.abort().catch(() => undefined);
  });

  it('abort removes the partial file and remove tolerates a missing file', async () => {
    const writer = await store.create(KEY);
    await writer.write(Buffer.from('x'));
    await writer.abort();
    expect(await store.stat(partialKey(KEY))).toBeNull();
    await store.remove(KEY);
    await mkdir(join(dir, 'raw-cdrs/2026'), { recursive: true });
    await writeFile(join(dir, KEY), 'x');
    await store.remove(KEY);
    expect(await store.stat(KEY)).toBeNull();
  });
});
