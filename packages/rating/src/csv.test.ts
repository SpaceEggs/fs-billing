import { expect, test } from 'vitest';
import { parseRateCsv } from './index.js';

test('valid file with header, BOM and CRLF', () => {
  const result = parseRateCsv(
    '\uFEFFprefix,country,rate\r\n1876,牙买加,0.2000\r\n447,英国手机,0.0450\r\n',
    'CNY',
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(
    result.entries.map((e) => [
      e.prefix,
      e.country,
      e.perMinute.perMinute.toString(),
    ]),
  ).toEqual([
    ['1876', '牙买加', '0.2'],
    ['447', '英国手机', '0.045'],
  ]);
});

test('3 bad rows → 3 errors with line numbers, nothing imported', () => {
  const result = parseRateCsv(
    [
      'prefix,country,rate',
      '1876,牙买加,0.2000',
      '44a,英国,0.0400',
      '1876,重复,0.1000',
      '447,英国手机,-0.0450',
      '86,中国,0.0100',
    ].join('\n'),
    'CNY',
  );
  expect(result).toEqual({
    ok: false,
    errors: [
      { line: 3, reason: '前缀只能是数字：44a' },
      { line: 4, reason: '前缀 1876 与第 2 行重复' },
      { line: 5, reason: '费率不能为负：-0.0450' },
    ],
  });
});

test.each([
  ['1,美国,0.12345', '费率最多 4 位小数：0.12345'],
  ['1,美国,abc', '费率不是数字：abc'],
  ['1,美国', '应为 3 列，实际 2 列'],
  [',美国,0.1', '前缀只能是数字：'],
])('%s → %s', (row, reason) => {
  expect(parseRateCsv(row, 'USD')).toEqual({
    ok: false,
    errors: [{ line: 1, reason }],
  });
});

test('empty file is rejected', () => {
  expect(parseRateCsv('prefix,country,rate\n', 'USD')).toEqual({
    ok: false,
    errors: [{ line: 1, reason: '文件没有费率行' }],
  });
});
