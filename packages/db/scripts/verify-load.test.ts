import { describe, expect, test } from 'vitest';
import {
  authorizationLatencies,
  exactDecimalEqual,
  parseSippCounts,
  percentiles,
  recomputeCharge,
  reconcileTotals,
} from './verify-load.js';

describe('recomputeCharge 复现真实扣费规则', () => {
  test('未接通不收费、不写流水', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000001',
      currency: 'CNY',
      rate: null,
      durationSeconds: 30,
      answered: false,
    });
    expect(result).toEqual({
      ok: true,
      billedMinutes: '0',
      charge: '0',
      ledgerAmount: '0',
      expectsLedger: false,
    });
  });

  test('接通 1 秒按首段 60 秒计 1 分钟', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000002',
      currency: 'CNY',
      rate: '0.3000',
      durationSeconds: 1,
      answered: true,
    });
    expect(result).toEqual({
      ok: true,
      billedMinutes: '1',
      charge: '0.3',
      ledgerAmount: '-0.3',
      expectsLedger: true,
    });
  });

  test('61 秒按 2 分钟计费，不是四舍五入', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000003',
      currency: 'CNY',
      rate: '0.3000',
      durationSeconds: 61,
      answered: true,
    });
    expect(result.ok && result.billedMinutes).toBe('2');
    expect(result.ok && result.charge).toBe('0.6');
  });

  test('费率 4 位小数时保留全部小数位，不提前舍入', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000004',
      currency: 'CNY',
      rate: '0.0333',
      durationSeconds: 61,
      answered: true,
    });
    expect(result.ok && result.charge).toBe('0.0666');
    expect(result.ok && result.ledgerAmount).toBe('-0.0666');
  });

  test('0 费率金额为 0，不写流水', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000005',
      currency: 'CNY',
      rate: '0.0000',
      durationSeconds: 60,
      answered: true,
    });
    expect(result.ok && result.charge).toBe('0');
    expect(result.ok && result.expectsLedger).toBe(false);
  });

  test('已接通 0 秒不收费（与 priceCall 一致）', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000006',
      currency: 'CNY',
      rate: '0.3000',
      durationSeconds: 0,
      answered: true,
    });
    expect(result.ok && result.charge).toBe('0');
    expect(result.ok && result.expectsLedger).toBe(false);
  });

  test('USD 租户用 USD 费率快照', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000007',
      currency: 'USD',
      rate: '0.0100',
      durationSeconds: 120,
      answered: true,
    });
    expect(result.ok && result.charge).toBe('0.02');
    expect(result.ok && result.ledgerAmount).toBe('-0.02');
  });

  test('已接通但缺少费率快照记为失败', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-000000000008',
      currency: 'CNY',
      rate: null,
      durationSeconds: 10,
      answered: true,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('缺少费率快照');
  });

  test('负数或非整数时长记为失败', () => {
    for (const durationSeconds of [-1, 1.5]) {
      const result = recomputeCharge({
        callUuid: '00000000-0000-4000-8000-000000000009',
        currency: 'CNY',
        rate: '0.3',
        durationSeconds,
        answered: true,
      });
      expect(result.ok).toBe(false);
    }
  });

  test('费率超过 4 位小数记为失败', () => {
    const result = recomputeCharge({
      callUuid: '00000000-0000-4000-8000-00000000000a',
      currency: 'CNY',
      rate: '0.00001',
      durationSeconds: 60,
      answered: true,
    });
    expect(result.ok).toBe(false);
  });
});

describe('exactDecimalEqual 不做容差', () => {
  test('仅末尾 0 不同视为相等', () => {
    expect(exactDecimalEqual('0.30', '0.3')).toBe(true);
    expect(exactDecimalEqual('1', '1.0000')).toBe(true);
  });

  test('差最后一位不相等', () => {
    expect(exactDecimalEqual('0.0666', '0.0667')).toBe(false);
    expect(exactDecimalEqual('5400', '5399.9999')).toBe(false);
  });
});

describe('reconcileTotals 三方逐位核对', () => {
  test('重算、流水、余额变化完全相等时无差异', () => {
    expect(
      reconcileTotals({
        recomputed: '540.0666',
        ledger: '-540.0666',
        balanceDelta: '-540.0666',
      }),
    ).toEqual([]);
  });

  test('流水少一笔时指出差异', () => {
    const failures = reconcileTotals({
      recomputed: '10',
      ledger: '-9.9',
      balanceDelta: '-10',
    });
    expect(failures).toHaveLength(2);
    expect(failures.some((line) => line.includes('流水合计'))).toBe(true);
  });

  test('余额变化对不上时指出差异', () => {
    const failures = reconcileTotals({
      recomputed: '10',
      ledger: '-10',
      balanceDelta: '-9.9',
    });
    expect(failures).toHaveLength(2);
    expect(failures.some((line) => line.includes('余额变化'))).toBe(true);
  });
});

describe('parseSippCounts', () => {
  test('解析终端统计表的最后一次累计值', () => {
    const text = [
      '  Successful call     [  17990 ]',
      '  Failed call         [      0 ]',
      '  Successful call     [  18000 ]',
      '  Failed call         [      0 ]',
    ].join('\n');
    expect(parseSippCounts(text)).toEqual({
      successful: 18000,
      failed: 0,
      failed5xx: 0,
      timeouts: 0,
    });
  });

  test('解析 SIPp 3.6 的管道统计表（取累计列）', () => {
    const text = [
      '  Successful call        |        0                  |      360',
      '  Failed call            |        0                  |        0',
    ].join('\n');
    expect(parseSippCounts(text)).toEqual({
      successful: 360,
      failed: 0,
      failed5xx: 0,
      timeouts: 0,
    });
  });

  test('解析 -trace_stat CSV 的最后一行', () => {
    const text = [
      'StartTime;CurrentTime;SuccessfulCall;FailedCall;FailedCall(5xx);FailedCall(Timeout)',
      '100;200;10;0;0;0',
      '100;300;18000;2;1;1',
    ].join('\n');
    expect(parseSippCounts(text)).toEqual({
      successful: 18000,
      failed: 2,
      failed5xx: 1,
      timeouts: 1,
    });
  });

  test('解析不出来时返回原因而不是数字', () => {
    const result = parseSippCounts('no statistics here');
    expect(typeof result).toBe('string');
    expect(result).toContain('无法');
  });
});

describe('Worker 授权延迟', () => {
  test('只取 /authorize 的 responseTime', () => {
    const text = [
      JSON.stringify({ req: { url: '/authorize' }, responseTime: 12.5 }),
      JSON.stringify({ req: { url: '/cdr' }, responseTime: 99 }),
      JSON.stringify({ req: { url: '/authorize' }, res: { responseTime: 7 } }),
      'not json',
    ].join('\n');
    expect(authorizationLatencies(text)).toEqual([12.5, 7]);
  });

  test('分位数按最近秩取', () => {
    expect(percentiles([])).toBeUndefined();
    expect(percentiles([10, 20, 30, 40])).toEqual({
      count: 4,
      p50: 20,
      p95: 40,
      p99: 40,
    });
  });
});
