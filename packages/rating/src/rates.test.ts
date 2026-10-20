import { describe, expect, test } from 'vitest';
import {
  beijingTime,
  findRate,
  longestPrefix,
  parseDialedNumber,
  type DialedNumber,
  rate,
  type RateEntry,
  type RateTable,
} from './index.js';

const num = (raw: string): DialedNumber => parseDialedNumber(raw)!;
const entry = (prefix: string, country: string, value: string) =>
  ({
    iso: '',
    description: '',
    prefix,
    country,
    perMinute: rate('CNY', value),
  }) as RateEntry<'CNY'>;

describe('design.md §6.2 最长前缀', () => {
  const entries = [
    entry('1', '北美', '0.0300'),
    entry('1876', '牙买加', '0.2000'),
    entry('44', '英国', '0.0400'),
    entry('447', '英国手机', '0.0450'),
  ];
  test.each([
    ['18761234567', '1876'],
    ['44712345678', '447'],
    ['12125551234', '1'],
    ['442071234567', '44'],
  ])('%s → %s', (dialed, prefix) => {
    expect(longestPrefix(entries, num(dialed))?.prefix).toBe(prefix);
  });
  test('no match', () => {
    expect(longestPrefix(entries, num('8613800000000'))).toBeUndefined();
  });
});

describe('design.md §6.3 生效时间', () => {
  const table: RateTable<'CNY'> = {
    currency: 'CNY',
    versions: [
      {
        effectiveFrom: beijingTime('2026-10-01 00:00'),
        entries: [entry('447', '英国手机', '0.0480')],
      },
      {
        effectiveFrom: beijingTime('2026-01-01 00:00'),
        entries: [entry('447', '英国手机', '0.0450')],
      },
    ],
  };
  test.each([
    ['2026-09-30 23:59:59', '0.045'],
    ['2026-10-01 00:00:00', '0.048'],
    ['2026-12-31 12:00:00', '0.048'],
  ])('接通于 %s 用 %s', (at, expected) => {
    const found = findRate(table, num('44712345678'), beijingTime(at));
    expect(found?.perMinute.perMinute.toString()).toBe(expected);
  });
  test('before any version there is no rate', () => {
    expect(
      findRate(table, num('44712345678'), beijingTime('2025-12-31 23:59:59')),
    ).toBeUndefined();
  });
});

test('longest prefix returns the matched entry own ISO and description', () => {
  const rows = [
    {
      prefix: '44',
      iso: 'GB',
      country: '英国',
      description: '',
      perMinute: rate('CNY', '0.02'),
    },
    {
      prefix: '447',
      iso: 'GB',
      country: '英国',
      description: '手机',
      perMinute: rate('CNY', '0.045'),
    },
  ];
  expect(longestPrefix(rows, num('447700900123'))).toBe(rows[1]);
  expect(longestPrefix(rows, num('442071234567'))).toBe(rows[0]);
});
