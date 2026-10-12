import { expect, test } from 'vitest';
import { beijingDay, beijingMonth, beijingTime } from './index.js';

test('Beijing midnight is 16:00 UTC the day before', () => {
  expect(beijingTime('2026-10-01 00:00').toISOString()).toBe(
    '2026-09-30T16:00:00.000Z',
  );
});

test.each([
  ['2026-09-30T15:59:59Z', '2026-09-30', '2026-09'],
  ['2026-09-30T16:00:00Z', '2026-10-01', '2026-10'],
  ['2026-12-31T16:30:00Z', '2027-01-01', '2027-01'],
])('answered %s → day %s, month %s', (iso, day, month) => {
  const answeredAt = new Date(iso);
  expect(beijingDay(answeredAt)).toBe(day);
  expect(beijingMonth(answeredAt)).toBe(month);
});

test('a call crossing midnight belongs to the answer day', () => {
  // 23:50 接通、00:20 挂断：只按接通时间归属。
  expect(beijingDay(beijingTime('2026-10-31 23:50:00'))).toBe('2026-10-31');
  expect(beijingMonth(beijingTime('2026-10-31 23:50:00'))).toBe('2026-10');
});

test.each(['2026-02-30 00:00', '2026/10/01 00:00', 'x'])('rejects %s', (s) => {
  expect(() => beijingTime(s)).toThrow('北京时间');
});
