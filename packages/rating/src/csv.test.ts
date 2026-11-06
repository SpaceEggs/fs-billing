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
  ['ß,英国,44,,0.02', { key: 'errors:csv.row.iso', params: { iso: 'ß' } }],
  ['GBR,英国,44,,0.02', { key: 'errors:csv.row.iso', params: { iso: 'GBR' } }],
  ['G1,英国,44,,0.02', { key: 'errors:csv.row.iso', params: { iso: 'G1' } }],
  [
    '英国,英国,44,,0.02',
    { key: 'errors:csv.row.iso', params: { iso: '英国' } },
  ],
  ['GB,,44,,0.02', { key: 'errors:csv.row.countryEmpty' }],
  [
    'GB,英国,447,0.0450',
    { key: 'errors:csv.row.columnCount', params: { count: 4 } },
  ],
  [
    'GB,英国,44,,0.02,x',
    { key: 'errors:csv.row.columnCount', params: { count: 6 } },
  ],
  [
    'GB,英国,44a,,0.02',
    { key: 'errors:csv.row.prefixDigits', params: { prefix: '44a' } },
  ],
  [
    'GB,英国,,,0.02',
    { key: 'errors:csv.row.prefixDigits', params: { prefix: '' } },
  ],
  [
    'GB,英国,0044,,0.02',
    {
      key: 'errors:csv.row.prefixLeadingZeros',
      params: { prefix: '0044' },
    },
  ],
  [
    'GB,英国,44,,abc',
    { key: 'errors:csv.row.rateNotNumber', params: { rate: 'abc' } },
  ],
  [
    'GB,英国,44,,-1',
    { key: 'errors:csv.row.rateNegative', params: { rate: '-1' } },
  ],
  [
    'GB,英国,44,,0.12345',
    {
      key: 'errors:csv.row.rateMaxFourDecimals',
      params: { rate: '0.12345' },
    },
  ],
  ['GB,"英国"x,44,,0.02', { key: 'errors:csv.row.quoteAfter' }],
  ['GB,英"国,44,,0.02', { key: 'errors:csv.row.quoteInUnquoted' }],
  ['GB,"英国,44,,0.02', { key: 'errors:csv.row.quoteUnclosed' }],
])('row errors keep their physical line numbers: %s', (row, error) => {
  expect(parseRateCsv(`\n${header}\n\n${row}`, 'CNY')).toEqual({
    ok: false,
    errors: [{ line: 4, ...error }],
  });
});

test.each(['prefix,country,rate', '前缀,国家,费率', '44,英国,0.02'])(
  'old three-column format %s gets only the dedicated error',
  (old) => {
    const result = parseRateCsv(`\n${old}\n44,英国,bad`, 'CNY');
    expect(result).toEqual({
      ok: false,
      errors: [{ line: 2, key: 'errors:csv.file.oldFormat' }],
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
          key: 'errors:csv.file.invalidHeader',
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
      errors: [{ line: 1, key: 'errors:csv.file.empty' }],
    });
  },
);

test('duplicate prefixes across descriptions are rejected, including prefixes on invalid rows', () => {
  expect(parse('GB,,44,,0.02\nGB,英国,44,手机,0.05')).toEqual({
    ok: false,
    errors: [
      { line: 2, key: 'errors:csv.row.countryEmpty' },
      {
        line: 3,
        key: 'errors:csv.row.duplicatePrefix',
        params: { prefix: '44', firstLine: 2 },
      },
    ],
  });
});

test('validateEntry errors are merged with parser errors by physical line', () => {
  expect(
    parseRateCsv(
      `${header}\nGB,英国,44,,0.02\nGB,英国,0044,,0.02\nGB,英国,447,手机,0.05`,
      'CNY',
      {
        validateEntry: (entry) =>
          entry.description
            ? { key: 'test.description' }
            : { key: 'test.country' },
      },
    ),
  ).toEqual({
    ok: false,
    errors: [
      { line: 2, key: 'test.country' },
      {
        line: 3,
        key: 'errors:csv.row.prefixLeadingZeros',
        params: { prefix: '0044' },
      },
      { line: 4, key: 'test.description' },
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
  const text = formatRateCsv(entries, 'en');
  expect(text).toBe(
    `${header}\n,=shared,1,"a, ""quote""",0.0100\nGB,英国,44,,0.0200\n`,
  );
  expect(parseRateCsv(text, 'CNY')).toEqual({ ok: true, entries });
});

test('exports the Chinese header by default and round-trips it', () => {
  const entries = [
    {
      iso: 'GB',
      country: '英国',
      prefix: '44',
      description: '',
      perMinute: rate('CNY', '0.02'),
    },
  ];
  const text = formatRateCsv(entries);
  expect(text).toBe('ISO,国家,号码前缀,说明,费率\nGB,英国,44,,0.0200\n');
  expect(parseRateCsv(text, 'CNY')).toEqual({ ok: true, entries });
});

test('exports the English header with locale en and round-trips it', () => {
  const entries = [
    {
      iso: 'GB',
      country: '英国',
      prefix: '44',
      description: 'Mobile',
      perMinute: rate('CNY', '0.02'),
    },
  ];
  const text = formatRateCsv(entries, 'en');
  expect(text).toBe(
    'ISO,Country,Destination Prefix,Description,Rate\nGB,英国,44,Mobile,0.0200\n',
  );
  expect(parseRateCsv(text, 'CNY')).toEqual({ ok: true, entries });
});

test('keeps the data rows byte-identical across locales; only the header follows the locale', () => {
  const entries = [
    {
      iso: 'GB',
      country: '英国',
      prefix: '44',
      description: 'a, "quote"',
      perMinute: rate('CNY', '0.02'),
    },
  ];
  const zh = formatRateCsv(entries, 'zh').split('\n');
  const en = formatRateCsv(entries, 'en').split('\n');
  expect(zh.slice(1)).toEqual(en.slice(1));
  expect(zh[0]).toBe('ISO,国家,号码前缀,说明,费率');
  expect(en[0]).toBe('ISO,Country,Destination Prefix,Description,Rate');
});

test('export quotes newlines', () => {
  expect(
    formatRateCsv(
      [
        {
          iso: '',
          prefix: '1',
          country: 'A\nB',
          description: '',
          perMinute: rate('USD', '0.01'),
        },
      ],
      'en',
    ),
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
