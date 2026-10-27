import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { Connection } from '../src/client.js';
import { ensureCdrPartitions } from '../src/partitions.js';
import { LocalArchiveStore } from '../src/raw-archive/store.js';

/** 每个测试文件一个临时归档目录，文件结束时删除。 */
export function temporaryStore(): { store: LocalArchiveStore; dir: string } {
  const state: { dir?: string; store?: LocalArchiveStore } = {};
  afterAll(async () => {
    if (state.dir) await rm(state.dir, { recursive: true, force: true });
  });
  return {
    get store() {
      return (state.store ??= new LocalArchiveStore(this.dir));
    },
    get dir() {
      return (state.dir ??= join(
        tmpdir(),
        `fsb-archive-${randomUUID().slice(0, 8)}`,
      ));
    },
  };
}

export async function makeTemporaryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fsb-archive-'));
}

export interface RawFixtureRow {
  id: string;
  /** 带微秒的 UTC 文本，如 2020-03-14 08:21:09.123456+00。 */
  receivedAt: string;
  body: string;
}

/**
 * 一批对「逐字节相同」有挑战的原文：多字节 UTF-8、4 字节字符、组合字符、行分隔符、BOM、CRLF、
 * 制表符与行尾空白、重复键与键序、看起来像转义的字面文本、非法 JSON、空串、1 MiB 的长文本。
 */
export function trickyBodies(): { name: string; body: string }[] {
  const big = ('长 line ' + 'é😀'.repeat(20) + ' \t "q" \\ /\r\n').repeat(
    Math.ceil(1_048_576 / 60),
  );
  // 按 UTF-8 字节数裁成恰好 1 MiB，不在多字节字符中间截断。
  const parts: string[] = [];
  let size = 0;
  for (const char of big) {
    const next = Buffer.byteLength(char, 'utf8');
    if (size + next > 1_048_576) break;
    parts.push(char);
    size += next;
  }
  const long = parts.join('');
  return [
    {
      name: 'pretty printed json with trailing newline',
      body: `${JSON.stringify({ variables: { uuid: randomUUID(), billing_tenant: 'ABC001' } }, null, 2)}\n`,
    },
    {
      name: 'chinese, emoji and combining marks',
      body: '{"caller":"张伟 👨‍👩‍👧","note":"é = é ; 😀 ; العربية ; ‮"}',
    },
    {
      name: 'line separators, bom and zero width characters',
      body: '﻿{"a":"x y z​‍"}',
    },
    {
      name: 'crlf, tabs and trailing blanks',
      body: '{\r\n\t"a": 1,   \r\n\t"b":\t2\r\n}   \r\n\r\n',
    },
    {
      name: 'duplicate keys, key order and number spellings',
      body: '{"b":1,"a":2,"a":3,"n":[1.0,1e3,-0,12345678901234567890,0.10]}',
    },
    {
      name: 'text that looks like escapes',
      body: '{"s":"\\u0000 \\ud83d \\n \\\\ \\"","raw":"\\/"}',
    },
    {
      name: 'not json at all',
      body: "plain text, not json: <xml/> ; 'single'",
    },
    { name: 'whitespace only', body: ' \t\r\n ' },
    { name: 'empty string', body: '' },
    { name: 'one mebibyte of mixed text', body: long },
  ];
}

/** 确保月份对应的分区存在，再用 owner 连接写入原文。 */
export async function seedRawMonth(
  app: Connection,
  owner: Connection,
  month: string,
  rows: readonly RawFixtureRow[],
): Promise<void> {
  await ensureCdrPartitions(app.db, {
    moment: new Date(`${month}T12:00:00+08:00`),
    monthsAhead: 0,
  });
  const chunk = 200;
  for (let start = 0; start < rows.length; start += chunk) {
    const part = rows.slice(start, start + chunk);
    await owner.pool.query(
      `INSERT INTO raw_cdrs (id, received_at, body)
       SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::text[])`,
      [
        part.map((row) => row.id),
        part.map((row) => row.receivedAt),
        part.map((row) => row.body),
      ],
    );
  }
}

/** 确定性的 UUID：按序号排序与按 id 排序一致。 */
export function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

/** 数据库里每行原文的 UTF-8 字节（十六进制），用来和恢复结果比较。 */
export async function bodyBytesBefore(
  owner: Connection,
  month: string,
): Promise<Map<string, { receivedAt: string; hex: string }>> {
  const { rows } = await owner.pool.query<{
    id: string;
    received_at: string;
    hex: string;
  }>(
    `SELECT id::text, to_char(received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS received_at,
            encode(convert_to(body, 'UTF8'), 'hex') AS hex
     FROM raw_cdrs
     WHERE received_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
       AND received_at < (($1::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai')`,
    [month],
  );
  return new Map(
    rows.map((row) => [row.id, { receivedAt: row.received_at, hex: row.hex }]),
  );
}

/** 一个月分区内容的摘要（id、received_at、body、payload 都进哈希），整月恢复前后比较。 */
export async function monthDigest(
  owner: Connection,
  month: string,
): Promise<{ n: number; digest: string }> {
  const { rows } = await owner.pool.query<{ n: number; digest: string }>(
    `SELECT count(*)::int AS n,
            coalesce(md5(string_agg(id::text || '|' || received_at::text || '|' || body || '|' || coalesce(payload::text, ''),
              E'\\n' ORDER BY received_at, id)), '') AS digest
     FROM raw_cdrs
     WHERE received_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
       AND received_at < (($1::date + interval '1 month')::timestamp AT TIME ZONE 'Asia/Shanghai')`,
    [month],
  );
  return rows[0]!;
}
