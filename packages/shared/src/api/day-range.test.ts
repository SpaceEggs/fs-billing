import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  beijingRangeBounds,
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

describe('beijingRangeBounds', () => {
  it('turns inclusive Beijing dates into a half-open UTC interval', () => {
    expect(
      beijingRangeBounds({ from: '2026-09-01', to: '2026-09-30' }),
    ).toEqual({
      start: '2026-08-31T16:00:00.000Z',
      end: '2026-09-30T16:00:00.000Z',
    });
  });

  it('puts a call answered at UTC 2026-09-28 16:30 on the 29th', () => {
    const { start, end } = beijingRangeBounds({
      from: '2026-09-29',
      to: '2026-09-29',
    });
    const answered = '2026-09-28T16:30:00.000Z';
    expect(start <= answered && answered < end).toBe(true);
    const previous = beijingRangeBounds({
      from: '2026-09-28',
      to: '2026-09-28',
    });
    expect(previous.start <= answered && answered < previous.end).toBe(false);
  });
});
