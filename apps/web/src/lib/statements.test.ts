import { describe, expect, it } from 'vitest';
import {
  countryShare,
  daysBetween,
  fillStatementDays,
  formatStatementMinutes,
  previousBeijingMonth,
  reconcileNote,
  shiftStatementMonth,
  statementMonthEnd,
  statementMonthLabel,
  sumStatementRows,
} from './statements';

describe('statement months', () => {
  it('labels and shifts months across years', () => {
    expect(statementMonthLabel('2026-09')).toBe('2026年9月');
    expect(shiftStatementMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftStatementMonth('2026-12', 1)).toBe('2027-01');
    expect(statementMonthEnd('2026-02')).toBe('2026-02-28');
    expect(statementMonthEnd('2028-02')).toBe('2028-02-29');
  });

  it('takes the previous month in Beijing time, not UTC', () => {
    // UTC 2026-09-30 17:00 是北京时间 10 月 1 日 01:00。
    expect(previousBeijingMonth(new Date('2026-09-30T17:00:00.000Z'))).toBe(
      '2026-09',
    );
    expect(previousBeijingMonth(new Date('2026-09-30T15:59:59.000Z'))).toBe(
      '2026-08',
    );
    expect(previousBeijingMonth(new Date('2026-01-15T00:00:00.000Z'))).toBe(
      '2025-12',
    );
  });
});

describe('breakdown tables', () => {
  it('fills every day of the period, including a month starting on the opening day', () => {
    expect(daysBetween('2026-08-30', '2026-09-02')).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
    const days = fillStatementDays({ from: '2026-08-12', to: '2026-08-31' }, [
      { day: '2026-08-20', calls: 3, minutes: '7', charge: '1.5' },
    ]);
    expect(days).toHaveLength(20);
    expect(days[0]).toEqual({
      day: '2026-08-12',
      calls: 0,
      minutes: '0',
      charge: '0',
    });
    expect(days[8]).toMatchObject({ day: '2026-08-20', calls: 3 });
  });

  it('sums rows exactly and computes shares of the row total', () => {
    const rows = [
      { calls: 2, minutes: '3', charge: '0.1' },
      { calls: 1, minutes: '4.5', charge: '0.2' },
    ];
    expect(sumStatementRows(rows)).toEqual({
      calls: 3,
      minutes: '7.5',
      charge: '0.3',
    });
    expect(countryShare('0.1', '0.3')).toBe('33.3%');
    expect(countryShare('0.2', '0.3')).toBe('66.7%');
    expect(countryShare('0', '0')).toBe('0.0%');
  });

  it('groups minutes with thousands separators', () => {
    expect(formatStatementMinutes('37468')).toBe('37,468');
    expect(formatStatementMinutes('0')).toBe('0');
    expect(formatStatementMinutes('1234.5')).toBe('1,234.5');
  });
});

describe('reconcile notes', () => {
  it('words stale and inconsistent, and says nothing otherwise', () => {
    expect(reconcileNote('stale')).toBe('账单已过期');
    expect(reconcileNote('inconsistent')).toBe('账单与流水不一致');
    expect(reconcileNote('ok')).toBeNull();
    expect(reconcileNote('unchecked')).toBeNull();
    expect(reconcileNote(null)).toBeNull();
  });
});
