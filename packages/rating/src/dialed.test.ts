import { expect, test } from 'vitest';
import {
  invalidCases,
  loadDialedCases,
  validCases,
} from '../../../tests/dialed-cases.js';
import { normalizeDialedNumber, resolveBillingNumber } from './dialed.js';

// 用例在 freeswitch/tests/dialed-cases.tsv，Lua 的 billing_authorize_test.lua 读同一个文件。
const cases = loadDialedCases();
const valid = validCases(cases);
const invalid = invalidCases(cases);

test.each(valid.map((c) => [c.dialed, c.billing] as const))(
  'normalizes %j to %j',
  (dialed, billing) => {
    expect(normalizeDialedNumber(dialed)).toBe(billing);
  },
);

test.each(invalid.map((c) => [c.dialed] as const))(
  'rejects invalid billing or routed number %j',
  (dialed) => {
    expect(normalizeDialedNumber(dialed)).toBeUndefined();
  },
);

test('verifies the normalized callee and claimed billing number', () => {
  expect(
    resolveBillingNumber({
      callee: '13055551234',
      dialedNumber: '+13055551234',
      billingNumber: '13055551234',
    }),
  ).toEqual({ ok: true, billingNumber: '13055551234' });
  for (const input of [
    { callee: '13800138000', dialedNumber: '13800138000' },
    {
      callee: '8613800138000',
      dialedNumber: '13800138000',
      billingNumber: '13800138000',
    },
  ]) {
    expect(resolveBillingNumber(input)).toEqual({
      error: 'mismatch',
      billingNumber: '8613800138000',
    });
  }
});

test.each(invalid.map((c) => [c.dialed] as const))(
  'rejects invalid dialed number %j before checking its projection',
  (dialedNumber) => {
    expect(resolveBillingNumber({ callee: '', dialedNumber })).toEqual({
      error: 'format',
    });
  },
);

test.each(valid.map((c) => [c.dialed, c.billing] as const))(
  'resolves %j to the billing number %j',
  (dialedNumber, billingNumber) => {
    expect(
      resolveBillingNumber({
        dialedNumber,
        billingNumber,
        callee: billingNumber,
      }),
    ).toEqual({ ok: true, billingNumber });
  },
);
