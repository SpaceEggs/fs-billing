import { expect, test } from 'vitest';
import { decimal } from './index.js';

test('decimal arithmetic retains exact decimal input', () => {
  expect(decimal('0.1').mul('3').toString()).toBe('0.3');
});

test.each(['NaN', 'Infinity', '-Infinity'])(
  'rejects non-finite input %s',
  (value) => {
    expect(() => decimal(value)).toThrow('有限十进制数');
  },
);
