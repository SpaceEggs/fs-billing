import { describe, expect, it } from 'vitest';
import {
  beijingTime,
  decimal,
  findRate,
  parseDialedNumber,
  parseRateCsv,
  priceCall,
  versionAt,
} from '@fs-billing/rating';
import { OCTOBER_RATES_CSV, RATES_CSV } from './seed.js';
import {
  planAbc01Unassigned,
  planEmptyTagUnassigned,
  planIgnoredUnassigned,
} from './seed-unassigned.js';

function table(effectiveFrom: string) {
  const first = parseRateCsv(RATES_CSV, 'CNY');
  const october = parseRateCsv(OCTOBER_RATES_CSV, 'CNY');
  if (!first.ok || !october.ok) throw new Error('测试费率表无效');
  return {
    currency: 'CNY' as const,
    versions: [
      { effectiveFrom: beijingTime(effectiveFrom), entries: first.entries },
      {
        effectiveFrom: beijingTime('2026-10-01 00:00:00'),
        entries: october.entries,
      },
    ],
  };
}

// ABC001 的两个费率版本：开户（2026-08-12 09:30）起首版，2026-10-01 起 447 调价。
const abc001 = table('2026-08-12 09:30:00');

describe('ABC01 unassigned seed (phase 8 decision 37)', () => {
  const rows = planAbc01Unassigned();
  // 加上原有的新加坡示例话单（seed.ts，9-28，120 秒，0.056）共 326 条。
  const legacyCharge = priceCall(
    120,
    abc001.versions[0]!.entries.find((e) => e.prefix === '65')!.perMinute,
  ).charge.value;

  const priced = rows.map((row) => {
    const billing = parseDialedNumber(row.billingNumber)!;
    const entry = findRate(abc001, billing, row.answeredAt);
    return {
      row,
      entry,
      charge: entry
        ? priceCall(row.durationSeconds, entry.perMinute).charge.value
        : null,
    };
  });

  it('has 323 calls on 09-29 and 2 early calls, 325 new rows in total', () => {
    expect(rows).toHaveLength(325);
    const sept = rows.filter(
      (r) => r.answeredAt >= beijingTime('2026-09-29 00:00:00'),
    );
    expect(sept).toHaveLength(323);
    expect(new Set(rows.map((r) => r.callUuid)).size).toBe(325);
  });

  it('prices the 324 assignable calls at exactly 58.35 with the legacy example row', () => {
    const assignable = priced.filter((p) => p.charge !== null);
    expect(assignable).toHaveLength(323);
    const total = assignable.reduce(
      (sum, p) => sum.plus(p.charge!),
      legacyCharge,
    );
    expect(total.toFixed()).toBe('58.35');
    expect(decimal('-35.20').minus(total).toFixed()).toBe('-93.55');
  });

  it('leaves 2 calls with no rate at the answer time, both to prefix 1876 before the first version', () => {
    const noRate = priced.filter((p) => p.charge === null);
    expect(noRate.map((p) => p.row.billingNumber)).toEqual([
      '18765551234',
      '18765559876',
    ]);
    for (const p of noRate) {
      expect(versionAt(abc001, p.row.answeredAt)).toBeUndefined();
      expect(p.row.answeredAt.getTime()).toBeLessThan(
        abc001.versions[0]!.effectiveFrom.getTime(),
      );
    }
    // 不靠删前缀：首个版本里 1876 的最长前缀仍存在，是接通早于生效才没有费率。
    expect(
      findRate(
        abc001,
        parseDialedNumber('18765551234')!,
        beijingTime('2026-09-29 10:00:00'),
      )?.prefix,
    ).toBe('1876');
  });

  it('never prices a September call with the October rate version', () => {
    for (const p of priced.filter((p) => p.entry))
      expect(p.row.answeredAt.getTime()).toBeLessThan(
        beijingTime('2026-10-01 00:00:00').getTime(),
      );
  });
});

describe('mockup empty-tag and ignored rows (phase 8 decision 47)', () => {
  const empty = planEmptyTagUnassigned();
  const ignored = planIgnoredUnassigned();

  it('plans 12 pending calls with an empty tag on 2026-09-29', () => {
    expect(
      empty.map((row) => ({
        tag: row.tenantTag,
        caller: row.caller,
        callee: row.callee,
        billingNumber: row.billingNumber,
        seconds: row.durationSeconds,
        reason: row.reason,
        answeredAt: row.answeredAt.toISOString(),
        hangupCause: row.hangupCause,
      })),
    ).toEqual([
      row('8613710023757', 311, '2026-09-29T05:45:10.000Z'),
      row('8613710245489', 27, '2026-09-29T05:27:24.000Z'),
      row('8613710467221', 343, '2026-09-29T05:09:46.000Z'),
      row('8613710688953', 59, '2026-09-29T04:51:59.000Z'),
      row('8613710910685', 375, '2026-09-29T04:34:20.000Z'),
      row('8613711132417', 91, '2026-09-29T04:16:32.000Z'),
      row('8613711354149', 407, '2026-09-29T03:58:52.000Z'),
      row('8613711575881', 123, '2026-09-29T03:41:03.000Z'),
      row('8613711797613', 439, '2026-09-29T03:23:22.000Z'),
      row('8613712019345', 155, '2026-09-29T03:05:32.000Z'),
      row('8613712241077', 471, '2026-09-29T02:47:50.000Z'),
      row('8613712462809', 187, '2026-09-29T02:30:16.000Z'),
    ]);
    for (const call of empty) {
      expect(call.callUuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(call.endedAt.getTime() - call.answeredAt.getTime()).toBe(
        call.durationSeconds * 1000,
      );
      expect(call.answeredAt.getTime()).toBeGreaterThan(
        call.startedAt.getTime(),
      );
    }
  });

  it('plans 5 ignored calls with the mockup reasons and operators', () => {
    expect(
      ignored.map((row) => ({
        tag: row.tenantTag,
        caller: row.caller,
        callee: row.callee,
        billingNumber: row.billingNumber,
        seconds: row.durationSeconds,
        reason: row.reason,
        ignoreReason: row.ignoreReason,
        admin: row.admin,
        answeredAt: row.answeredAt.toISOString(),
        resolvedAt: row.resolvedAt.toISOString(),
      })),
    ).toEqual([
      ignoredRow({
        tag: 'TEST',
        caller: '075500000001',
        callee: '8613800000001',
        seconds: 12,
        reason: '租户不存在',
        ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
        admin: 'wang',
        answeredAt: '2026-09-28T09:42:10.000Z',
        resolvedAt: '2026-09-28T10:05:00.000Z',
      }),
      ignoredRow({
        tag: 'TEST',
        caller: '075500000001',
        callee: '8613800000001',
        seconds: 9,
        reason: '租户不存在',
        ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
        admin: 'wang',
        answeredAt: '2026-09-28T09:40:51.000Z',
        resolvedAt: '2026-09-28T10:05:00.000Z',
      }),
      ignoredRow({
        tag: 'TEST',
        caller: '075500000001',
        callee: '8613800000002',
        seconds: 31,
        reason: '租户不存在',
        ignoreReason: 'FreeSWITCH 测试呼叫，不属于任何客户',
        admin: 'wang',
        answeredAt: '2026-09-28T09:39:33.000Z',
        resolvedAt: '2026-09-28T10:05:00.000Z',
      }),
      ignoredRow({
        tag: '',
        caller: '02088776600',
        callee: '8613500135000',
        seconds: 64,
        reason: '缺少租户标签',
        ignoreReason: '内部线路，运维排障拨测',
        admin: 'li',
        answeredAt: '2026-09-26T02:15:08.000Z',
        resolvedAt: '2026-09-26T03:30:00.000Z',
      }),
      ignoredRow({
        tag: '',
        caller: '02088776600',
        callee: '8613500135000',
        seconds: 58,
        reason: '缺少租户标签',
        ignoreReason: '内部线路，运维排障拨测',
        admin: 'li',
        answeredAt: '2026-09-26T02:12:47.000Z',
        resolvedAt: '2026-09-26T03:30:00.000Z',
      }),
    ]);
  });

  it('keeps every seeded call uuid distinct from the ABC01 plan', () => {
    const ids = [
      ...planAbc01Unassigned().map((row) => row.callUuid),
      ...empty.map((row) => row.callUuid),
      ...ignored.map((row) => row.callUuid),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('a00000ff-0000-4000-8000-000000000001');
  });
});

function row(digits: string, seconds: number, answeredAt: string) {
  return {
    tag: '',
    caller: '02088776655',
    callee: `+${digits}`,
    billingNumber: digits,
    seconds,
    reason: '缺少租户标签',
    answeredAt,
    hangupCause: 'NORMAL_CLEARING',
  };
}

function ignoredRow(input: {
  tag: string;
  caller: string;
  callee: string;
  seconds: number;
  reason: string;
  ignoreReason: string;
  admin: 'wang' | 'li';
  answeredAt: string;
  resolvedAt: string;
}) {
  return {
    ...input,
    callee: `+${input.callee}`,
    billingNumber: input.callee,
  };
}
