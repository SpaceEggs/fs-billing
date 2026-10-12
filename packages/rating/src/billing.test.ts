import { describe, expect, test } from 'vitest';
import {
  billedSeconds,
  formatMoney,
  priceCall,
  rate,
  type BillingCycle,
} from './index.js';

describe('design.md §5 计费示例（费率 0.1000，60/60）', () => {
  const perMinute = rate('CNY', '0.1000');
  test.each([
    ['0:00', 0, '0', '0.00'],
    ['0:01', 1, '1', '0.10'],
    ['3:10', 190, '4', '0.40'],
    ['3:50', 230, '4', '0.40'],
    ['4:00', 240, '4', '0.40'],
    ['4:01', 241, '5', '0.50'],
  ])('%s → %s 秒 → %s 分钟 → %s', (_label, seconds, minutes, shown) => {
    const { billedMinutes, charge } = priceCall(seconds, perMinute);
    expect(billedMinutes.toString()).toBe(minutes);
    expect(formatMoney(charge)).toBe(shown);
  });
});

test('fee is not rounded before display', () => {
  const { charge } = priceCall(61, rate('CNY', '0.0333'));
  expect(charge.value.toString()).toBe('0.0666');
  expect(formatMoney(charge)).toBe('0.07');
});

describe('billing cycle parameter', () => {
  const six: BillingCycle = { initialSeconds: 6, incrementSeconds: 6 };
  const one: BillingCycle = { initialSeconds: 1, incrementSeconds: 1 };
  const thirtySix: BillingCycle = { initialSeconds: 30, incrementSeconds: 6 };
  test.each([
    [six, 1, 6],
    [six, 7, 12],
    [one, 61, 61],
    [thirtySix, 20, 30],
    [thirtySix, 31, 36],
  ])('%o: %i 秒 → %i 秒', (cycle, talk, billed) => {
    expect(billedSeconds(talk, cycle)).toBe(billed);
  });

  test('6/6 bills tenths of a minute', () => {
    const { billedMinutes, charge } = priceCall(7, rate('USD', '0.1000'), six);
    expect(billedMinutes.toString()).toBe('0.2');
    expect(charge.value.toString()).toBe('0.02');
  });

  test.each([-1, 1.5])('rejects talk time %s', (talk) => {
    expect(() => billedSeconds(talk)).toThrow('通话时长');
  });
  test('rejects zero cycle', () => {
    expect(() =>
      billedSeconds(5, { initialSeconds: 0, incrementSeconds: 6 }),
    ).toThrow('首段周期');
  });
});
