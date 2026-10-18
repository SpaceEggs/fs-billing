import { describe, expect, it } from 'vitest';
import { beijingDateOf, beijingDateTimeParts } from './beijing-time.js';

describe('Asia/Shanghai civil time', () => {
  it('uses the historical daylight-saving offset in 1988', () => {
    const instant = '1988-05-31T15:30:00Z';
    expect(beijingDateTimeParts(instant)).toEqual({
      year: 1988,
      month: 6,
      day: 1,
      hour: 0,
      minute: 30,
      second: 0,
    });
    expect(beijingDateOf(instant)).toBe('1988-06-01');
  });

  it('uses the historical local-mean-time offset and pads year 0001', () => {
    const instant = '0001-01-01T15:59:00Z';
    expect(beijingDateTimeParts(instant)).toEqual({
      year: 1,
      month: 1,
      day: 2,
      hour: 0,
      minute: 4,
      second: 43,
    });
    expect(beijingDateOf(instant)).toBe('0001-01-02');
  });

  it('keeps modern Beijing date boundaries and rejects invalid instants', () => {
    expect(beijingDateOf('2026-09-28T16:30:00Z')).toBe('2026-09-29');
    expect(() => beijingDateTimeParts('tomorrow')).toThrow(RangeError);
  });
});
