import { describe, expect, it } from 'vitest';
import { tenantUsageOverviewSchema } from './usage.js';

function overview(asOf = '2026-09-30T15:59:59Z', lastDate = '2026-09-30') {
  const midnight = Date.parse(`${lastDate}T00:00:00Z`);
  return {
    asOf,
    currency: 'USD',
    monthSpend: '1.23456789',
    monthCallMinutes: '000.123456',
    answeredCalls: 2,
    unansweredCalls: 1,
    dailyTotal: '1.23456789',
    daily: Array.from({ length: 30 }, (_, index) => ({
      date: new Date(midnight - (29 - index) * 86400000)
        .toISOString()
        .slice(0, 10),
      spend: index === 29 ? '1.23456789' : '0',
    })),
  };
}

describe('tenant usage overview contract', () => {
  it.each([
    ['2026-09-30T15:59:59Z', '2026-09-30'],
    ['2026-09-30T16:00:00Z', '2026-10-01'],
    ['2026-10-01T00:00:00+08:00', '2026-10-01'],
  ])('ends the 30 consecutive days at the Beijing date of %s', (asOf, date) => {
    const value = overview(asOf, date);
    expect(tenantUsageOverviewSchema.parse(value)).toEqual(value);
  });

  it('rejects a short or long series, gaps, duplicate days, reversed days and the wrong last day', () => {
    const value = overview();
    for (const daily of [
      value.daily.slice(1),
      [...value.daily, { date: '2026-10-01', spend: '0' }],
      value.daily.map((day, index) =>
        index === 5 ? { ...day, date: '2026-09-01' } : day,
      ),
      [...value.daily].reverse(),
      overview(value.asOf, '2026-09-29').daily,
    ])
      expect(
        tenantUsageOverviewSchema.safeParse({ ...value, daily }).success,
      ).toBe(false);
  });

  it('rejects negative amounts, minutes, counts, fractional counts and malformed instants', () => {
    const value = overview();
    for (const changed of [
      { monthSpend: '-1' },
      { dailyTotal: '-1' },
      { monthCallMinutes: '-1' },
      { answeredCalls: -1 },
      { unansweredCalls: -1 },
      { answeredCalls: 1.5 },
      { asOf: 'yesterday' },
      { asOf: '2026-09-30T12:00:00' },
      {
        daily: value.daily.map((day, index) =>
          index === 29 ? { ...day, spend: '-0.1' } : day,
        ),
      },
    ])
      expect(
        tenantUsageOverviewSchema.safeParse({ ...value, ...changed }).success,
      ).toBe(false);
  });
});
