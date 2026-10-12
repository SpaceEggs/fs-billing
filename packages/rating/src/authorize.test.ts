import { describe, expect, test } from 'vitest';
import {
  authorize,
  beijingTime,
  money,
  rate,
  type RateTable,
  type Tenant,
} from './index.js';

const at = beijingTime('2026-10-12 10:00:00');
const rates = (value: string): RateTable<'CNY'> => ({
  currency: 'CNY',
  versions: [
    {
      effectiveFrom: beijingTime('2026-01-01 00:00'),
      entries: [
        { prefix: '447', country: '英国手机', perMinute: rate('CNY', value) },
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
    expect(authorize(tenant('-35.20'), '44712345678', at)).toMatchObject({
      allowed: true,
      callableMinutes: 1350,
      maxSeconds: 14400,
    });
  });

  test('small balance is not capped', () => {
    expect(authorize(tenant('-99.00'), '44712345678', at)).toMatchObject({
      allowed: true,
      callableMinutes: 20,
      maxSeconds: 1200,
    });
  });

  test('−100.00 + 100.00 → 余额不足', () => {
    expect(authorize(tenant('-100.00'), '44712345678', at)).toEqual({
      allowed: false,
      reason: '余额不足',
    });
  });

  test('less than one minute available → 余额不足', () => {
    expect(authorize(tenant('-99.96'), '44712345678', at)).toEqual({
      allowed: false,
      reason: '余额不足',
    });
  });

  test('unknown tenant → 租户不存在', () => {
    expect(authorize(undefined, '44712345678', at)).toEqual({
      allowed: false,
      reason: '租户不存在',
    });
  });

  test('disabled tenant → 租户已停用', () => {
    expect(
      authorize(tenant('50', { status: 'disabled' }), '44712345678', at),
    ).toEqual({ allowed: false, reason: '租户已停用' });
  });

  test('no prefix match → 无费率', () => {
    expect(authorize(tenant('50'), '8613800000000', at)).toEqual({
      allowed: false,
      reason: '无费率',
    });
  });

  test('zero rate with positive funds → 4 h cap', () => {
    expect(
      authorize(tenant('0', {}, '0.0000'), '44712345678', at),
    ).toMatchObject({ allowed: true, maxSeconds: 14400 });
  });

  test('zero rate without funds → 余额不足', () => {
    expect(authorize(tenant('-100', {}, '0.0000'), '44712345678', at)).toEqual({
      allowed: false,
      reason: '余额不足',
    });
  });
});
