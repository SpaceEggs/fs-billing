import { describe, expect, it } from 'vitest';
import {
  beijingMonthToDate,
  monthCells,
  rangeLabel,
  rangeOrMonthToDate,
  shiftMonth,
} from './day-range';

describe('day range', () => {
  it('takes the month from Beijing time, not UTC', () => {
    expect(beijingMonthToDate(new Date('2026-09-30T16:00:00.000Z'))).toEqual({
      from: '2026-10-01',
      to: '2026-10-01',
    });
    expect(beijingMonthToDate(new Date('2026-09-30T15:59:59.999Z'))).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('fills a missing end from the month and swaps a reversed range', () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    expect(rangeOrMonthToDate({ from: '2026-10-05' }, now)).toEqual({
      from: '2026-10-05',
      to: '2026-10-17',
    });
    expect(
      rangeOrMonthToDate({ from: '2026-09-29', to: '2026-09-01' }, now),
    ).toEqual({ from: '2026-09-01', to: '2026-09-29' });
  });

  it('replaces endpoints after Beijing today with the month default', () => {
    const now = new Date('2026-10-17T10:00:00.000Z');
    expect(
      rangeOrMonthToDate({ from: '2026-11-01', to: '2026-11-30' }, now),
    ).toEqual({ from: '2026-10-01', to: '2026-10-17' });
    expect(rangeOrMonthToDate({ from: '2026-11-01' }, now)).toEqual({
      from: '2026-10-01',
      to: '2026-10-17',
    });
    expect(
      rangeOrMonthToDate({ from: '2026-09-20', to: '2026-10-18' }, now),
    ).toEqual({ from: '2026-09-20', to: '2026-10-17' });
    expect(
      rangeOrMonthToDate({ from: '2026-10-17', to: '2026-10-17' }, now),
    ).toEqual({ from: '2026-10-17', to: '2026-10-17' });
  });

  it('labels the end without the year on mobile only within one year', () => {
    const range = { from: '2026-09-01', to: '2026-09-29' };
    expect(rangeLabel(range)).toBe('2026-09-01 — 2026-09-29');
    expect(rangeLabel(range, true)).toBe('2026-09-01 — 09-29');
    expect(rangeLabel({ from: '2025-12-30', to: '2026-01-02' }, true)).toBe(
      '2025-12-30 — 2026-01-02',
    );
  });

  it('lays out a Monday-first month and steps across years', () => {
    const september = monthCells({ year: 2026, month: 9 });
    expect(september.slice(0, 2)).toEqual([null, '2026-09-01']);
    expect(september.at(-1)).toBe('2026-09-30');
    expect(september).toHaveLength(31);
    expect(monthCells({ year: 2028, month: 2 }).at(-1)).toBe('2028-02-29');
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    });
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    });
  });
});
