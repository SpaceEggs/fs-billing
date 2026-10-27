import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { trickyBodies } from '../../test/raw-archive.js';
import {
  FingerprintAccumulator,
  RowsDigest,
  bodySha256,
  compressMember,
  decodeMember,
  encodeLine,
  sha256Hex,
} from './format.js';
import { beijingMonthOf, normalizeReceivedAt } from './read.js';
import { archiveFileKey, rawPartitionName } from './types.js';

const id = '00000000-0000-4000-8000-000000000001';

describe('archive line format', () => {
  it('round-trips every awkward body byte for byte', async () => {
    const lines = trickyBodies().map(({ body }, index) => ({
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      receivedAt: '2026-03-14T08:21:09.123456Z',
      sha256: bodySha256(body),
      body,
    }));
    const member = await compressMember(lines.map(encodeLine));
    const decoded = await decodeMember(member);
    expect(decoded).toEqual(lines);
    for (const [index, line] of decoded.entries())
      expect(
        Buffer.from(line.body, 'utf8').equals(
          Buffer.from(lines[index]!.body, 'utf8'),
        ),
      ).toBe(true);
  });

  it('writes the keys in a fixed order, one line per row, ending in a newline', () => {
    const bytes = encodeLine({
      id,
      receivedAt: '2026-03-14T08:21:09.123456Z',
      sha256: bodySha256('a\nb'),
      body: 'a\nb',
    });
    const text = bytes.toString('utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split('\n')).toHaveLength(2);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'id',
      'receivedAt',
      'sha256',
      'body',
    ]);
    expect(text).toContain('"body":"a\\nb"');
  });

  it('members concatenate into a valid multi-member gzip stream', async () => {
    const a = await compressMember([
      encodeLine({
        id,
        receivedAt: '2026-03-14T08:21:09.000001Z',
        sha256: bodySha256('1'),
        body: '1',
      }),
    ]);
    const b = await compressMember([
      encodeLine({
        id,
        receivedAt: '2026-03-14T08:21:09.000002Z',
        sha256: bodySha256('2'),
        body: '2',
      }),
    ]);
    const { gunzipSync } = await import('node:zlib');
    const whole = gunzipSync(Buffer.concat([a, b]))
      .toString('utf8')
      .trim()
      .split('\n');
    expect(
      whole.map((line) => (JSON.parse(line) as { body: string }).body),
    ).toEqual(['1', '2']);
  });

  it('never puts the offending text into an error message', async () => {
    const secret = '13800138000-secret-number';
    const broken = gzipSync(Buffer.from(`{"id": "${secret}\n`));
    const failure = await decodeMember(broken).catch(
      (error: unknown) => error as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain(secret);
    const wrongShape = gzipSync(
      Buffer.from(`{"id":"${id}","extra":"${secret}"}\n`),
    );
    const shape = await decodeMember(wrongShape).catch(
      (error: unknown) => error as Error,
    );
    expect((shape as Error).message).not.toContain(secret);
    await expect(decodeMember(Buffer.from('not gzip'))).rejects.toThrow(
      '无法解压',
    );
    await expect(decodeMember(gzipSync(Buffer.from('{}')))).rejects.toThrow(
      '行结束符',
    );
  });

  it('digests are stable and order sensitive', () => {
    const forward = new RowsDigest();
    const backward = new RowsDigest();
    const [a, b] = [sha256Hex('a'), sha256Hex('b')];
    forward.add(a);
    forward.add(b);
    backward.add(b);
    backward.add(a);
    const forwardDigest = forward.digest();
    expect(forwardDigest).not.toBe(backward.digest());
    expect(forwardDigest).toBe(
      sha256Hex(Buffer.concat([Buffer.from(a, 'hex'), Buffer.from(b, 'hex')])),
    );
  });

  it('accumulates the partition fingerprint as 64-bit signed values', () => {
    const accumulator = new FingerprintAccumulator();
    accumulator.add(10, '-9223372036854775808');
    accumulator.add(5, '9223372036854775807');
    expect(accumulator.result()).toEqual({
      count: 2,
      bodyBytes: 15,
      xor: '-1',
    });
    expect(new FingerprintAccumulator().result()).toEqual({
      count: 0,
      bodyBytes: 0,
      xor: '0',
    });
  });
});

describe('received_at', () => {
  it.each([
    ['2026-03-14T08:21:09.123456Z', '2026-03-14T08:21:09.123456Z'],
    ['2026-03-14 08:21:09.123456+00', '2026-03-14T08:21:09.123456Z'],
    ['2026-03-14 16:21:09.123456+08', '2026-03-14T08:21:09.123456Z'],
    ['2026-03-14T16:21:09.5+08:00', '2026-03-14T08:21:09.500000Z'],
    ['2026-03-14T08:21:09Z', '2026-03-14T08:21:09.000000Z'],
    ['2026-03-14T03:51:09.000001-04:30', '2026-03-14T08:21:09.000001Z'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeReceivedAt(input)).toBe(expected);
  });

  it.each([
    'yesterday',
    '2026-03-14',
    '2026-03-14T08:21:09.1234567Z',
    '2026-13-14T08:21:09Z',
    '',
  ])('rejects %j', (input) => {
    expect(() => normalizeReceivedAt(input)).toThrow('received_at');
  });

  it('puts an instant in the right Beijing month', () => {
    expect(beijingMonthOf('2026-03-31T15:59:59.999999Z')).toBe('2026-03-01');
    expect(beijingMonthOf('2026-03-31T16:00:00.000000Z')).toBe('2026-04-01');
    expect(beijingMonthOf('2026-12-31T16:00:00.000000Z')).toBe('2027-01-01');
  });

  it('derives file and partition names from the month only', () => {
    expect(archiveFileKey('2026-03-01')).toBe(
      'raw-cdrs/2026/raw-cdrs-2026-03.jsonl.gz',
    );
    expect(rawPartitionName('2026-03-01')).toBe('raw_cdrs_2026_03');
    expect(() => archiveFileKey('2026-03-02')).toThrow();
    expect(() => rawPartitionName("2026-03-01'; drop table x; --")).toThrow();
  });
});
