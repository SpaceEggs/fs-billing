import { describe, expect, it } from 'vitest';
import {
  previousBeijingMonth,
  reconcileNote,
  shiftStatementMonth,
} from './admin-statements';

describe('statement months', () => {
  it('shifts months across years', () => {
    expect(shiftStatementMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftStatementMonth('2026-12', 1)).toBe('2027-01');
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

describe('reconcile notes', () => {
  it('words stale and inconsistent, and says nothing otherwise', () => {
    expect(reconcileNote('stale')).toBe('账单已过期');
    expect(reconcileNote('inconsistent')).toBe('账单与流水不一致');
    expect(reconcileNote('ok')).toBeNull();
    expect(reconcileNote('unchecked')).toBeNull();
    expect(reconcileNote(null)).toBeNull();
  });
});
