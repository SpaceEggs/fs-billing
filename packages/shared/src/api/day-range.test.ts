import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  checkDayRange,
  dayRangeFields,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
} from './day-range.js';

const rangeSchema = z.strictObject(dayRangeFields).superRefine(checkDayRange);

describe('latestRangeEnd', () => {
  it.each([
    ['2026-09-01', '2026-09-30'],
    ['2026-09-15', '2026-10-14'],
    ['2026-10-31', '2026-11-29'],
    ['2026-12-15', '2027-01-14'],
    ['2026-01-31', '2026-02-27'],
    ['2026-01-28', '2026-02-27'],
    ['2024-01-31', '2024-02-28'],
    ['2026-02-01', '2026-02-28'],
    ['2024-02-01', '2024-02-29'],
  ])('a range starting %s ends at the latest on %s', (from, latest) => {
    expect(latestRangeEnd(from)).toBe(latest);
  });
});

describe('one-month range', () => {
  it('accepts a whole calendar month and a single day', () => {
    expect(rangeSchema.parse({ from: '2026-09-01', to: '2026-09-30' })).toEqual(
      { from: '2026-09-01', to: '2026-09-30' },
    );
    expect(rangeSchema.parse({ from: '2026-09-29', to: '2026-09-29' })).toEqual(
      { from: '2026-09-29', to: '2026-09-29' },
    );
  });

  it('rejects one day past the month with the range message on to', () => {
    const result = rangeSchema.safeParse({
      from: '2026-09-01',
      to: '2026-10-01',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['to'], message: '日期范围最长一个月' }),
    ]);
  });

  it('rejects a range that ends before it starts', () => {
    const result = rangeSchema.safeParse({
      from: '2026-09-10',
      to: '2026-09-09',
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['to'],
        message: '结束日期不能早于开始日期',
      }),
    ]);
  });

  it('rejects dates that do not exist and unknown keys', () => {
    expect(
      rangeSchema.safeParse({ from: '2026-02-30', to: '2026-03-01' }).success,
    ).toBe(false);
    expect(
      rangeSchema.safeParse({
        from: '2026-09-01',
        to: '2026-09-02',
        tenantId: 'x',
      }).success,
    ).toBe(false);
  });

  it('answers the same question as the helper', () => {
    expect(isDayRangeWithinOneMonth('2026-09-15', '2026-10-14')).toBe(true);
    expect(isDayRangeWithinOneMonth('2026-09-15', '2026-10-15')).toBe(false);
    expect(isDayRangeWithinOneMonth('2026-09-15', '2026-09-14')).toBe(false);
  });
});

describe('malformed dates', () => {
  it.each([
    ['bad', 'bad'],
    ['2026-xx-01', '2026-xx-01'],
    ['2026-09-01', 'bad'],
    ['bad', '2026-09-01'],
  ])('fail as one ordinary issue for from=%s to=%s', (from, to) => {
    const result = rangeSchema.safeParse({ from, to });
    expect(result.success).toBe(false);
    expect(
      result.error?.issues.every((issue) => issue.code === 'invalid_format'),
    ).toBe(true);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual(
      [from, to].flatMap((value, index) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) ? [] : [[['from', 'to'][index]]],
      ),
    );
  });
});

describe('one-month rule across every four-digit year', () => {
  it.each([
    ['0001-01-01', '0001-01-31', true],
    ['0001-01-01', '0100-01-01', false],
    ['0050-03-15', '0050-04-14', true],
    ['0050-03-15', '0050-04-15', false],
    ['0099-12-31', '0100-01-30', true],
    ['9999-12-01', '9999-12-31', true],
    ['9999-12-31', '9999-12-31', true],
    ['0000-12-31', '0001-01-30', true],
  ])('%s to %s is %s', (from, to, allowed) => {
    expect(rangeSchema.safeParse({ from, to }).success).toBe(allowed);
    expect(isDayRangeWithinOneMonth(from, to)).toBe(allowed);
  });

  it.each([
    ['0001-01-01', '0001-01-31'],
    ['0001-01-31', '0001-02-27'],
    ['0099-02-01', '0099-02-28'],
    ['0100-01-31', '0100-02-27'],
    ['0400-01-31', '0400-02-28'],
    ['9999-12-01', '9999-12-31'],
    ['9999-12-31', '9999-12-31'],
  ])('a range starting %s ends at the latest on %s', (from, latest) => {
    expect(latestRangeEnd(from)).toBe(latest);
  });
});
