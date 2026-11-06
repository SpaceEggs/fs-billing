import { describe, expect, it } from 'vitest';
import {
  formatBilledMinutes,
  formatDate,
  formatDateTime,
  formatExactMoney,
  formatMoney,
  formatMonth,
  formatRate,
  isNegativeMoney,
} from './format';
import { formatDuration } from './duration';

describe('formatMoney', () => {
  it.each([
    ['CNY', '-35.2', '-¥35.20'],
    ['CNY', '-35.20', '-¥35.20'],
    ['USD', '-35.2', '-$35.20'],
    ['USD', '1234.56', '$1,234.56'],
    ['CNY', '1234.56', '¥1,234.56'],
    ['CNY', '0', '¥0.00'],
    ['CNY', '1234567.891', '¥1,234,567.89'],
    ['CNY', '0.005', '¥0.01'],
    ['CNY', '-0.005', '-¥0.01'],
    ['CNY', '-0.004', '¥0.00'],
    ['USD', '9007199254740993.125', '$9,007,199,254,740,993.13'],
  ] as const)('%s %s → %s', (currency, amount, expected) => {
    expect(formatMoney({ currency, amount })).toBe(expected);
  });

  it('treats only amounts that stay negative after rounding as negative', () => {
    expect(isNegativeMoney({ currency: 'CNY', amount: '-35.2' })).toBe(true);
    expect(isNegativeMoney({ currency: 'CNY', amount: '-0.004' })).toBe(false);
    expect(isNegativeMoney({ currency: 'CNY', amount: '35.2' })).toBe(false);
  });
});

describe('formatExactMoney', () => {
  it.each([
    ['CNY', '-12.3456', '-¥12.3456'],
    ['CNY', '-0.0001', '-¥0.0001'],
    ['CNY', '500', '¥500.00'],
    ['USD', '1234.5', '$1,234.50'],
    ['CNY', '-9999999999.9999', '-¥9,999,999,999.9999'],
  ] as const)('%s %s → %s', (currency, amount, expected) => {
    expect(formatExactMoney({ currency, amount })).toBe(expected);
  });
});

describe('formatRate', () => {
  it.each([
    ['0.045', {}, '0.0450'],
    ['0.05', {}, '0.0500'],
    ['0.12345', {}, '0.1235'],
    ['0.045', { currency: 'CNY', unit: true }, '0.0450 元/分钟'],
    ['0.012', { currency: 'USD', unit: true }, '$0.0120/分钟'],
    ['0.012', { currency: 'USD' }, '0.0120'],
  ] as const)('%s %j → %s', (rate, options, expected) => {
    expect(formatRate(rate, options)).toBe(expected);
  });
});

describe('time formatting in Asia/Shanghai time', () => {
  it('uses current and historical timezone rules, crossing the day boundary', () => {
    expect(formatDateTime('2026-09-28T16:30:00Z')).toBe('2026-09-29 00:30:00');
    expect(formatDateTime('2026-09-29T06:03:22.000Z')).toBe(
      '2026-09-29 14:03:22',
    );
    expect(formatDateTime('1988-05-31T15:30:00Z')).toBe('1988-06-01 00:30:00');
    expect(formatDateTime('0001-01-01T15:59:00Z')).toBe('0001-01-02 00:04:43');
    expect(formatDate('0001-01-01T15:59:00Z')).toBe('0001-01-02');
  });

  it('formats months as YYYY年M月 in Beijing time', () => {
    expect(formatMonth('2026-09-30T16:00:00Z')).toBe('2026年10月');
    expect(formatMonth('2026-09-30T15:59:59Z')).toBe('2026年9月');
  });

  it('formats durations and billed minutes', () => {
    expect(formatDuration(230)).toBe('3分50秒');
    expect(formatDuration(724)).toBe('12分04秒');
    expect(formatDuration(871.2)).toBe('14分32秒');
    expect(formatDuration(-3)).toBe('0分00秒');
    expect(formatBilledMinutes(4)).toBe('4分钟');
  });

  it('rejects invalid timestamps', () => {
    expect(() => formatDateTime('tomorrow')).toThrow(RangeError);
  });
});

describe('English formatting (docs/i18n-design.md §7)', () => {
  it('writes date-times and dates as DD MMM YYYY', () => {
    expect(formatDateTime('2026-09-29T06:03:22.000Z', 'en')).toBe(
      '29 Sep 2026 14:03:22',
    );
    expect(formatDate('2026-09-29T06:03:22.000Z', 'en')).toBe('29 Sep 2026');
    expect(formatDate('2026-01-05T00:00:00Z', 'en')).toBe('05 Jan 2026');
  });

  it('writes months as MMM YYYY', () => {
    expect(formatMonth('2026-09-30T16:00:00Z', 'en')).toBe('Oct 2026');
    expect(formatMonth('2026-09-30T15:59:59Z', 'en')).toBe('Sep 2026');
  });

  it('writes durations and billed minutes in English', () => {
    expect(formatDuration(230, 'en')).toBe('3m 50s');
    expect(formatDuration(724, 'en')).toBe('12m 04s');
    expect(formatDuration(-3, 'en')).toBe('0m 00s');
    expect(formatBilledMinutes(4, 'en')).toBe('4 min');
  });

  it('writes rate units in English', () => {
    expect(
      formatRate('0.045', { currency: 'CNY', unit: true, locale: 'en' }),
    ).toBe('¥0.0450/min');
    expect(
      formatRate('0.012', { currency: 'USD', unit: true, locale: 'en' }),
    ).toBe('$0.0120/min');
  });

  it('keeps money formatting identical in both languages', () => {
    expect(formatMoney({ currency: 'CNY', amount: '-1234.5' })).toBe(
      '-¥1,234.50',
    );
    expect(formatExactMoney({ currency: 'USD', amount: '-0.0001' })).toBe(
      '-$0.0001',
    );
  });
});
