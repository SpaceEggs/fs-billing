import { describe, expect, test } from 'vitest';
import {
  authorize,
  resolveBillingNumber,
  parseDialedNumber,
  beijingTime,
  money,
  rate,
  type RateTable,
  type Tenant,
} from './index.js';

const at = beijingTime('2026-10-12 10:00:00');
const ukNumber = parseDialedNumber('44712345678')!;
const rates = (value: string): RateTable<'CNY'> => ({
  currency: 'CNY',
  versions: [
    {
      effectiveFrom: beijingTime('2026-01-01 00:00'),
      entries: [
        {
          iso: '',
          description: '',
          prefix: '447',
          country: '英国手机',
          perMinute: rate('CNY', value),
        },
      ],
    },
  ],
});
const tenant = (
  balance: string,
  over: Partial<Tenant<'CNY'>> = {},
  value = '0.0480',
): Tenant<'CNY'> => ({
  code: 't1',
  status: 'active',
  currency: 'CNY',
  balance: money('CNY', balance),
  overdraft: money('CNY', '100.00'),
  rates: rates(value),
  ...over,
});

describe('authorize', () => {
  test('−35.20 + 100.00 at 0.0480 → 1350 minutes, capped to 14400 s', () => {
    expect(authorize(tenant('-35.20'), ukNumber, at)).toMatchObject({
      allowed: true,
      callableMinutes: 1350,
      maxSeconds: 14400,
    });
  });

  test('small balance is not capped', () => {
    expect(authorize(tenant('-99.00'), ukNumber, at)).toMatchObject({
      allowed: true,
      callableMinutes: 20,
      maxSeconds: 1200,
    });
  });

  test('−100.00 + 100.00 → 余额不足', () => {
    expect(authorize(tenant('-100.00'), ukNumber, at)).toEqual({
      allowed: false,
      reason: '余额不足',
    });
  });

  test('less than one minute available → 余额不足', () => {
    expect(authorize(tenant('-99.96'), ukNumber, at)).toEqual({
      allowed: false,
      reason: '余额不足',
    });
  });

  test('unknown tenant → 租户不存在', () => {
    expect(authorize(undefined, ukNumber, at)).toEqual({
      allowed: false,
      reason: '租户不存在',
    });
  });

  test('disabled tenant → 租户已停用', () => {
    expect(
      authorize(tenant('50', { status: 'disabled' }), ukNumber, at),
    ).toEqual({ allowed: false, reason: '租户已停用' });
  });

  test('no prefix match → 无费率', () => {
    expect(
      authorize(tenant('50'), parseDialedNumber('8613800000000')!, at),
    ).toEqual({
      allowed: false,
      reason: '无费率',
    });
  });

  test('zero rate with positive funds → 240 minutes / 14400 s, JSON-safe', () => {
    const result = authorize(tenant('0', {}, '0.0000'), ukNumber, at);
    expect(result).toMatchObject({
      allowed: true,
      callableMinutes: 240,
      maxSeconds: 14400,
    });
    const json = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(json.callableMinutes).toBe(240);
    expect(json.maxSeconds).toBe(14400);
    expect(Number.isFinite(json.callableMinutes)).toBe(true);
  });

  test('zero rate without funds → 余额不足', () => {
    expect(authorize(tenant('-100', {}, '0.0000'), ukNumber, at)).toEqual({
      allowed: false,
      reason: '余额不足',
    });
  });
});

describe('dialed number boundary', () => {
  test.each([
    ['+13055551234', '13055551234', '1'],
    ['13055551234', '8613055551234', '86'],
    ['13800138000', '8613800138000', '86'],
    ['075586001234', '8675586001234', '86'],
    ['0013055551234', '13055551234', '1'],
  ])('dialed form %s uses %s and prefix %s', (raw, normalized, prefix) => {
    const billing = resolveBillingNumber({
      callee: normalized,
      dialedNumber: raw,
    });
    if (!('ok' in billing)) throw new Error('Invalid fixture');
    const t = tenant('50', {
      rates: {
        currency: 'CNY',
        versions: [
          {
            effectiveFrom: at,
            entries: [
              {
                iso: '',
                description: '',
                prefix: '1',
                country: 'NANP',
                perMinute: rate('CNY', '1'),
              },
              {
                iso: '',
                description: '',
                prefix: '86',
                country: '中国',
                perMinute: rate('CNY', '0.1'),
              },
            ],
          },
        ],
      },
    });
    const result = authorize(t, billing.billingNumber, at);
    expect(result.allowed && result.entry.prefix).toBe(prefix);
    expect(result.allowed && result.maxSeconds).toBe(
      prefix === '1' ? 9000 : 14400,
    );
  });

  test.each(['+44', '0044', '', '4471234567x', ' 4471'])(
    '%j → 号码格式错误',
    (raw) => {
      expect(resolveBillingNumber({ dialedNumber: raw })).toEqual({
        error: 'format',
      });
    },
  );

  test('44712345678 matches 447 via typed authorize', () => {
    const dialed = parseDialedNumber('44712345678');
    expect(dialed).toBe('44712345678');
    const result = authorize(tenant('50'), dialed!, at);
    expect(result.allowed && result.entry.prefix).toBe('447');
  });

  test('raw string is not a DialedNumber', () => {
    // @ts-expect-error 必须先经 parseDialedNumber
    expect(authorize(tenant('50'), '44712345678', at).allowed).toBe(true);
  });
});
