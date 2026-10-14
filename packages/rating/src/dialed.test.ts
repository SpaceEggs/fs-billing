import { expect, test } from 'vitest';
import { normalizeDialedNumber, resolveBillingNumber } from './dialed.js';

test.each([
  ['00447700900123', '447700900123'],
  ['+447700900123', '447700900123'],
  ['13800138000', '8613800138000'],
  ['075586001234', '8675586001234'],
  ['+13055551234', '13055551234'],
  ['13055551234', '8613055551234'],
  ['00123456789012345', '123456789012345'],
  ['+123456789012345', '123456789012345'],
])('normalizes %s to %s', (dialed, billing) => {
  expect(normalizeDialedNumber(dialed)).toBe(billing);
});

test.each([
  '',
  '+',
  '00',
  '+001234',
  '000044712345678',
  '+1234567890123456',
  '001234567890123456',
  '138001380001234',
  '44712345678|evil',
  '44712345678,evil',
  '44712345678/evil',
  ' 13800138000',
  '13800138000 ',
  '+44 123',
  '123\n',
  '++123',
])('rejects invalid billing or routed number %j', (dialed) => {
  expect(normalizeDialedNumber(dialed)).toBeUndefined();
});

test('distinguishes legacy canonical numbers from new domestic numbers', () => {
  expect(resolveBillingNumber({ callee: '13055551234' })).toBe('13055551234');
  expect(
    resolveBillingNumber({
      callee: '13055551234',
      dialedNumber: '13055551234',
    }),
  ).toBe('8613055551234');
});

test('verifies claimed billing number and rejects incomplete new forms', () => {
  expect(
    resolveBillingNumber({
      callee: '+13055551234',
      dialedNumber: '+13055551234',
      billingNumber: '13055551234',
    }),
  ).toBe('13055551234');
  expect(
    resolveBillingNumber({
      callee: '13800138000',
      dialedNumber: '13800138000',
      billingNumber: '13800138000',
    }),
  ).toBeUndefined();
  expect(
    resolveBillingNumber({
      callee: '13800138000',
      billingNumber: '8613800138000',
    }),
  ).toBeUndefined();
  expect(
    resolveBillingNumber({ callee: '', dialedNumber: '' }),
  ).toBeUndefined();
  expect(
    resolveBillingNumber({ callee: '4471|evil', dialedNumber: '+4471' }),
  ).toBeUndefined();
});
