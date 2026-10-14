import { expect, test } from 'vitest';
import { formatRateCsv, parseRateCsv, rate } from './index.js';

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

test('quoted country with comma round-trips', () => {
  const text = 'prefix,country,rate\n447,"Korea, Republic of",0.0450\n';
  const parsed = parseRateCsv(text, 'USD');
  expect(parsed.ok && parsed.entries[0]?.country).toBe('Korea, Republic of');
  if (!parsed.ok) return;
  expect(formatRateCsv(parsed.entries)).toBe(text);
});

test('"" escapes a quote and round-trips', () => {
  const text = 'prefix,country,rate\n1,"美国 ""本土""",0.0100\n';
  const parsed = parseRateCsv(text, 'USD');
  expect(parsed.ok && parsed.entries[0]?.country).toBe('美国 "本土"');
  if (!parsed.ok) return;
  expect(formatRateCsv(parsed.entries)).toBe(text);
});

test('quoted prefix and rate are accepted', () => {
  const parsed = parseRateCsv('"1876","牙买加","0.2000"', 'USD');
  expect(parsed.ok && parsed.entries[0]?.prefix).toBe('1876');
});

test('trailing empty columns are tolerated', () => {
  const parsed = parseRateCsv('1876,牙买加,0.2000,,', 'CNY');
  expect(parsed.ok && parsed.entries.length).toBe(1);
});

test('header is detected on the first non-empty line only', () => {
  expect(parseRateCsv('\n\nprefix,country,rate\n1,美国,0.01', 'USD').ok).toBe(
    true,
  );
  expect(parseRateCsv('1,美国,0.01\nprefix,country,rate', 'USD')).toEqual({
    ok: false,
    errors: [{ line: 2, reason: '前缀只能是数字：prefix' }],
  });
});

test('newline inside quotes is an error with line number', () => {
  const result = parseRateCsv(
    'prefix,country,rate\n1,美国,0.01\n44,"英国\n本土",0.04\n',
    'USD',
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors[0]).toEqual({
    line: 3,
    reason: '引号未闭合（引号内不能换行）',
  });
});

test.each([
  ['1,"美国"x,0.01', '引号后只能是逗号'],
  ['1,美"国,0.01', '未加引号的字段中不能有引号'],
  ['1,,0.01', '国家/备注不能为空'],
  ['1,"",0.01', '国家/备注不能为空'],
  ['1,美国,0.01,x', '应为 3 列，实际 4 列'],
])('%s → %s', (row, reason) => {
  expect(parseRateCsv(row, 'USD')).toEqual({
    ok: false,
    errors: [{ line: 1, reason }],
  });
});

test('export quotes newlines', () => {
  expect(
    formatRateCsv([
      { prefix: '1', country: 'A\nB', perMinute: rate('USD', '0.01') },
    ]),
  ).toBe('prefix,country,rate\n1,"A\nB",0.0100\n');
});

test('prefix starting with 00 is rejected with line number', () => {
  expect(
    parseRateCsv('prefix,country,rate\n44,英国,0.04\n0044,英国,0.04', 'USD'),
  ).toEqual({
    ok: false,
    errors: [{ line: 3, reason: '前缀不能以 00 开头（国际冠字应去掉）：0044' }],
  });
});

test('Chinese header preserves the rating dialect and physical error lines', () => {
  const text = '\uFEFF\n 前缀,国家,费率,,\r\n44,"英国,本土",0.0400,,\r\n';
  const parsed = parseRateCsv(text, 'CNY');
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(formatRateCsv(parsed.entries)).toBe(
    'prefix,country,rate\n44,"英国,本土",0.0400\n',
  );
  expect(parseRateCsv(text + '44,重复,0.01\n', 'CNY')).toEqual({
    ok: false,
    errors: [{ line: 4, reason: '前缀 44 与第 3 行重复' }],
  });
  expect(parseRateCsv('44,英国,0.04\n前缀,国家,费率', 'CNY')).toEqual({
    ok: false,
    errors: [{ line: 2, reason: '前缀只能是数字：前缀' }],
  });
});
