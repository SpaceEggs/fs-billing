import { expect, test } from 'vitest';
import {
  CSV_BOM,
  CSV_EOL,
  csvCell,
  csvRecord,
  formatRateCsv,
  neutralizeCsvFormula,
  parseRateCsv,
  rate,
} from './index.js';

const header = 'ISO,Country,Destination Prefix,Description,Rate';
const parse = (rows: string) => parseRateCsv(`${header}\n${rows}`, 'CNY');

test('valid five-column file with header, BOM and CRLF', () => {
  const parsed = parseRateCsv(
    `\uFEFF${header}\r\nGB,英国,44,,0.0200\r\nGB,英国,447,手机,0.0450\r\n,美国/加拿大,1,,0.0100`,
    'CNY',
  );
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(
    parsed.entries.map(({ iso, country, prefix, description }) => ({
      iso,
      country,
      prefix,
      description,
    })),
  ).toEqual([
    { iso: 'GB', country: '英国', prefix: '44', description: '' },
    { iso: 'GB', country: '英国', prefix: '447', description: '手机' },
    { iso: '', country: '美国/加拿大', prefix: '1', description: '' },
  ]);
});

test.each([
  'iso,COUNTRY,destination prefix,Description,RATE',
  'ISO,Country,Destination Prefixes,Description,Rate',
  'ISO,国家,号码前缀,说明,费率',
])('accepts header %s and trailing empty columns', (heading) => {
  expect(parseRateCsv(`${heading},,\nkr,韩国,82,,0.05,,`, 'CNY')).toMatchObject(
    { ok: true, entries: [{ iso: 'KR', description: '' }] },
  );
});

test.each([
  ['ß,英国,44,,0.02', 'ISO 必须是两位字母，或留空：ß'],
  ['GBR,英国,44,,0.02', 'ISO 必须是两位字母，或留空：GBR'],
  ['G1,英国,44,,0.02', 'ISO 必须是两位字母，或留空：G1'],
  ['英国,英国,44,,0.02', 'ISO 必须是两位字母，或留空：英国'],
  ['GB,,44,,0.02', '国家不能为空'],
  ['GB,英国,447,0.0450', '应为 5 列，实际 4 列'],
  ['GB,英国,44,,0.02,x', '应为 5 列，实际 6 列'],
  ['GB,英国,44a,,0.02', '前缀只能是数字：44a'],
  ['GB,英国,,,0.02', '前缀只能是数字：'],
  ['GB,英国,0044,,0.02', '前缀不能以 00 开头（国际冠字应去掉）：0044'],
  ['GB,英国,44,,abc', '费率不是数字：abc'],
  ['GB,英国,44,,-1', '费率不能为负：-1'],
  ['GB,英国,44,,0.12345', '费率最多 4 位小数：0.12345'],
  ['GB,"英国"x,44,,0.02', '引号后只能是逗号'],
  ['GB,英"国,44,,0.02', '未加引号的字段中不能有引号'],
  ['GB,"英国,44,,0.02', '引号未闭合（引号内不能换行）'],
])('row errors keep their physical line numbers: %s', (row, reason) => {
  expect(parseRateCsv(`\n${header}\n\n${row}`, 'CNY')).toEqual({
    ok: false,
    errors: [{ line: 4, reason }],
  });
});

test.each(['prefix,country,rate', '前缀,国家,费率', '44,英国,0.02'])(
  'old three-column format %s gets only the dedicated error',
  (old) => {
    const result = parseRateCsv(`\n${old}\n44,英国,bad`, 'CNY');
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          line: 2,
          reason:
            '不再支持三列格式（前缀、国家、费率）。请改用五列并保留表头：ISO,Country,Destination Prefix,Description,Rate；可在导入对话框下载 CSV 模板',
        },
      ],
    });
  },
);

test.each([
  'GB,英国,447,手机,0.0450',
  'ISO,Country,Prefix,Description,Rate',
  'ISO，Country，Destination Prefix，Description，Rate',
  'prefix,country,price',
])(
  'header is mandatory and near-miss %s reports its physical line',
  (first) => {
    expect(parseRateCsv(`\uFEFF\n\n${first}\nGB,英国,44,,bad`, 'CNY')).toEqual({
      ok: false,
      errors: [
        expect.objectContaining({
          line: 3,
          reason:
            '表头无法识别，第一行必须是：ISO,Country,Destination Prefix,Description,Rate（也可用中文表头 ISO,国家,号码前缀,说明,费率）',
        }),
      ],
    });
  },
);

test.each(['', header, `${header}\n\n`])(
  'empty file is rejected: %s',
  (text) => {
    expect(parseRateCsv(text, 'CNY')).toEqual({
      ok: false,
      errors: [{ line: 1, reason: '文件没有费率行' }],
    });
  },
);

test('duplicate prefixes across descriptions are rejected, including prefixes on invalid rows', () => {
  expect(parse('GB,,44,,0.02\nGB,英国,44,手机,0.05')).toEqual({
    ok: false,
    errors: [
      { line: 2, reason: '国家不能为空' },
      { line: 3, reason: '前缀 44 与第 2 行重复' },
    ],
  });
});

test('validateEntry errors are merged with parser errors by physical line', () => {
  expect(
    parseRateCsv(
      `${header}\nGB,英国,44,,0.02\nGB,英国,0044,,0.02\nGB,英国,447,手机,0.05`,
      'CNY',
      {
        validateEntry: (entry) => (entry.description ? '说明错误' : '国家错误'),
      },
    ),
  ).toEqual({
    ok: false,
    errors: [
      { line: 2, reason: '国家错误' },
      { line: 3, reason: '前缀不能以 00 开头（国际冠字应去掉）：0044' },
      { line: 4, reason: '说明错误' },
    ],
  });
});

test('export writes five columns, LF, no BOM, four decimals and round-trips quotes without formula neutralization', () => {
  const entries = [
    {
      iso: '',
      country: '=shared',
      prefix: '1',
      description: 'a, "quote"',
      perMinute: rate('CNY', '0.01'),
    },
    {
      iso: 'GB',
      country: '英国',
      prefix: '44',
      description: '',
      perMinute: rate('CNY', '0.02'),
    },
  ];
  const text = formatRateCsv(entries);
  expect(text).toBe(
    `${header}\n,=shared,1,"a, ""quote""",0.0100\nGB,英国,44,,0.0200\n`,
  );
  expect(parseRateCsv(text, 'CNY')).toEqual({ ok: true, entries });
});

test('export quotes newlines', () => {
  expect(
    formatRateCsv([
      {
        iso: '',
        prefix: '1',
        country: 'A\nB',
        description: '',
        perMinute: rate('USD', '0.01'),
      },
    ]),
  ).toBe(`${header}\n,"A\nB",1,,0.0100\n`);
});

test.each([
  ['=1+1', "'=1+1"],
  ['=HYPERLINK("http://x")', `"'=HYPERLINK(""http://x"")"`],
  ['@SUM(A1)', "'@SUM(A1)"],
  ['+cmd|calc', "'+cmd|calc"],
  ['+44 7700 900123', "'+44 7700 900123"],
  ['-abc', "'-abc"],
  ['-1+1', "'-1+1"],
  ['\t=1', "'\t=1"],
  ['\r=1', `"'\r=1"`],
])('csvCell neutralizes the formula in %j', (input, expected) => {
  expect(csvCell(input)).toBe(expected);
});

test.each([
  '+447700900123',
  '-5',
  '-35.20',
  '+1300.00',
  '8613800138000',
  '075586001234',
  'NORMAL_CLEARING',
  '牙买加',
  '',
])('csvCell keeps the plain number or text %j', (input) => {
  expect(neutralizeCsvFormula(input)).toBe(input);
  expect(csvCell(input)).toBe(input);
});

test('csvCell applies the formula guard before RFC 4180 quoting', () => {
  expect(csvCell('a,b')).toBe('"a,b"');
  expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
  expect(csvCell('=a,b')).toBe(`"'=a,b"`);
  expect(csvCell(' padded ')).toBe('" padded "');
  expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
});

test('csvRecord joins guarded cells without a line terminator', () => {
  expect(
    csvRecord(['2026-09-28 10:00:00', '=evil', '+447700900123', '-12.50', '']),
  ).toBe("2026-09-28 10:00:00,'=evil,+447700900123,-12.50,");
  expect(CSV_BOM + csvRecord(['a']) + CSV_EOL).toBe('﻿a\r\n');
});
