import { describe, expect, test } from 'vitest';
import {
  addMoney,
  decimal,
  formatMoney,
  money,
  rate,
  type Money,
} from './index.js';

test('decimal arithmetic retains exact decimal input', () => {
  expect(decimal('0.1').mul('3').toString()).toBe('0.3');
});

test.each(['NaN', 'Infinity', '-Infinity'])('rejects non-finite %s', (v) => {
  expect(() => decimal(v)).toThrow('有限十进制数');
});

describe('Money', () => {
  test('adds same-currency amounts exactly', () => {
    const sum = addMoney(money('CNY', '-35.20'), money('CNY', '100.00'));
    expect(sum.currency).toBe('CNY');
    expect(sum.value.toString()).toBe('64.8');
  });

  test('CNY + USD is a type error', () => {
    const cny = money('CNY', '1.00');
    const usd = money('USD', '1.00');
    // @ts-expect-error 不同币种不能相加
    expect(() => addMoney(cny, usd)).toThrow('币种不一致：CNY 与 USD');
  });

  test('Money cannot be forged from a literal', () => {
    // @ts-expect-error 品牌字段缺失
    const forged: Money<'CNY'> = { currency: 'CNY', value: decimal('1') };
    expect(forged.currency).toBe('CNY');
  });

  test('Rate is not Money', () => {
    // @ts-expect-error 费率不能当金额使用
    const wrong: Money<'CNY'> = rate('CNY', '0.1000');
    expect(wrong.currency).toBe('CNY');
  });

  test.each([
    ['0.004', '0.00'],
    ['0.005', '0.01'],
    ['1.2345', '1.23'],
    ['-35.2', '-35.20'],
  ])('displays %s as %s', (value, shown) => {
    expect(formatMoney(money('USD', value))).toBe(shown);
  });
});

describe('Rate', () => {
  test('accepts up to 4 decimals', () => {
    expect(rate('CNY', '0.0480').perMinute.toString()).toBe('0.048');
  });
  test('rejects negative', () => {
    expect(() => rate('CNY', '-0.01')).toThrow('费率不能为负');
  });
  test('rejects 5 decimals', () => {
    expect(() => rate('CNY', '0.00001')).toThrow('最多 4 位小数');
  });
});
