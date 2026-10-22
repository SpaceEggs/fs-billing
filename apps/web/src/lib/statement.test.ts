import { describe, expect, it } from 'vitest';
import {
  chargeShare,
  fillDays,
  hasUnmatchedCharge,
  sumRows,
  hasNoActivity,
  isStatementsEmpty,
  minutesCount,
  nextMonthFirstDay,
  statementMonthRange,
  statementMonthTitle,
  statementPeriodLabel,
} from './statement';
import {
  augustFigures,
  emptyStatementsResponse,
  statementsResponse,
} from '../test/portal-statements';

describe('statement helpers', () => {
  it('titles a month and finds the next first day across the year end', () => {
    expect(statementMonthTitle('2026-09')).toBe('2026年9月');
    expect(statementMonthTitle('2026-12')).toBe('2026年12月');
    expect(nextMonthFirstDay('2026-09')).toBe('2026-10-01');
    expect(nextMonthFirstDay('2026-12')).toBe('2027-01-01');
  });

  it('exports the whole calendar month of CDRs', () => {
    expect(statementMonthRange('2026-09')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(statementMonthRange('2028-02')).toEqual({
      from: '2028-02-01',
      to: '2028-02-29',
    });
  });

  it('rounds minutes to a grouped whole number', () => {
    expect(minutesCount('49726')).toBe('49,726');
    expect(minutesCount('0')).toBe('0');
  });

  it('computes the share of the call charges with one decimal', () => {
    expect(chargeShare('1440.15', '1873.4')).toBe('76.9%');
    expect(chargeShare('4.65', '1873.4')).toBe('0.2%');
    expect(chargeShare('0', '0')).toBe('—');
  });

  it('fills every day of the period and zeroes the days without calls', () => {
    const rows = fillDays({ from: '2026-08-30', to: '2026-09-02' }, [
      { day: '2026-09-01', calls: 3, minutes: '9', charge: '0.45' },
    ]);
    expect(rows.map((row) => row.day)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
    ]);
    expect(rows[0]).toEqual({
      day: '2026-08-30',
      calls: 0,
      minutes: '0',
      charge: '0',
    });
    expect(rows[2]?.calls).toBe(3);
  });

  it('writes the period with the opening date and the in-progress mark', () => {
    expect(
      statementPeriodLabel(
        { from: '2026-08-12', to: '2026-08-31', openedOn: '2026-08-12' },
        'final',
      ),
    ).toBe('2026-08-12（开户）至 2026-08-31');
    expect(
      statementPeriodLabel(
        { from: '2026-09-01', to: '2026-09-29', openedOn: null },
        'in_progress',
      ),
    ).toBe('2026-09-01 至 2026-09-29（进行中）');
  });

  it('is empty only without statements and without activity this month', () => {
    expect(isStatementsEmpty(emptyStatementsResponse.items)).toBe(true);
    expect(isStatementsEmpty(statementsResponse.items)).toBe(false);
    const [live] = emptyStatementsResponse.items;
    if (!live) throw new Error('fixture');
    // 有账单行就不是空状态，即使数字全为 0。
    expect(isStatementsEmpty([{ ...live, state: 'final' }])).toBe(false);
    // 本月有一笔流水或一通已接通话单。
    expect(
      isStatementsEmpty([
        { ...live, figures: { ...live.figures, recharge: '3.51' } },
      ]),
    ).toBe(false);
    expect(
      isStatementsEmpty([{ ...live, figures: { ...live.figures, calls: 1 } }]),
    ).toBe(false);
    expect(hasNoActivity(augustFigures)).toBe(false);
  });

  it('sums rows and compares charges as exact decimals', () => {
    expect(
      sumRows([
        { calls: 1, minutes: '1', charge: '0.1' },
        { calls: 2, minutes: '2', charge: '0.2' },
      ]),
    ).toEqual({ calls: 3, minutes: '3', charge: '0.3' });
    expect(sumRows([])).toEqual({ calls: 0, minutes: '0', charge: '0' });
    expect(
      hasUnmatchedCharge('0.3', [{ charge: '0.1' }, { charge: '0.2' }]),
    ).toBe(false);
    expect(hasUnmatchedCharge('0.30', [{ charge: '0.3' }])).toBe(false);
    expect(hasUnmatchedCharge('1240.98', [{ charge: '0.23' }])).toBe(true);
    expect(hasUnmatchedCharge('0.1', [])).toBe(true);
  });
});
