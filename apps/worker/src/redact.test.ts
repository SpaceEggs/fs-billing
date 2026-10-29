import { Writable } from 'node:stream';
import { expect, test } from 'vitest';
import {
  billingMismatchLog,
  createWorkerLogger,
  maskNumber,
  numberShape,
} from './redact.js';

test.each([
  ['8613800138000', '8613*******00(13)'],
  ['+447700900123', '+4477******23(12)'],
  ['0013800138000', '0013*******00(13)'],
  ['1234567', '1234*67(7)'],
  ['123456', '*(6)'],
  ['12345', '*(5)'],
  ['', '*(0)'],
  ['+12345', '+*(5)'],
])('masks numbers: %s -> %s', (value, masked) => {
  expect(maskNumber(value)).toBe(masked);
});

test('masks numbers: a masked value never contains the middle digits', () => {
  const masked = maskNumber('8613800138000');
  expect(masked).not.toContain('80013');
  expect(masked).not.toContain('13800138');
});

test('number shape reports length and prefix without the digits', () => {
  expect(numberShape('+447700900123')).toEqual({
    length: 12,
    plus: true,
    doubleZero: false,
  });
  expect(numberShape('008613800138000')).toEqual({
    length: 15,
    plus: false,
    doubleZero: true,
  });
});

test('mismatch reason distinguishes a differing callee from a lua-only difference', () => {
  const base = {
    uuid: 'debf1234-1234-4234-8234-123456789abc',
    tenant: 'ABC01',
    dialedNumber: '13800138000',
    billingNumber: '8613800138000',
  };
  expect(billingMismatchLog({ ...base, callee: '13800138000' })).toMatchObject({
    reason: 'callee-differs',
    calleeEqualsDialed: false,
  });
  expect(
    billingMismatchLog({ ...base, luaBillingNumber: '13055551234' }),
  ).toMatchObject({
    reason: 'only-lua-differs',
    calleeEqualsDialed: null,
    luaEqualsWorker: false,
    callee: null,
  });
});

test('worker logger redacts the shared key and error detail', () => {
  let text = '';
  const logger = createWorkerLogger(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        text += chunk.toString('utf8');
        callback();
      },
    }),
  );
  const unique = Object.assign(new Error('duplicate key'), {
    code: '23505',
    detail: 'Key (callee)=(8613800138000) already exists.',
  });
  const wrapped = new Error('Failed query', { cause: unique });
  logger.error(
    {
      req: {
        headers: {
          'x-billing-key': 'super-secret-key',
          authorization: 'Bearer abc',
          'user-agent': 'fs',
        },
      },
      err: unique,
    },
    '直接',
  );
  logger.error({ err: wrapped }, '包了一层');
  expect(text).not.toContain('super-secret-key');
  expect(text).not.toContain('Bearer abc');
  expect(text).not.toContain('8613800138000');
  expect(text).toContain('"user-agent":"fs"');
  expect(text).toContain('duplicate key');
  expect(text).toContain('[Redacted]');
});
