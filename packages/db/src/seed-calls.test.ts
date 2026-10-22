import { describe, expect, it } from 'vitest';
import { beijingTime, decimal, parseRateCsv } from '@fs-billing/rating';
import {
  AUGUST_DAYS,
  SEPTEMBER_DAYS,
  allocateMonth,
  planAbc001Calls,
  type FixedCall,
  type PlannedCall,
} from './seed-calls.js';
import { RATES_CSV } from './seed.js';

const parsed = parseRateCsv(RATES_CSV, 'CNY');
if (!parsed.ok) throw new Error('测试费率表无效');
const entries = parsed.entries;

const fixedCalls: FixedCall[] = [
  {
    callUuid: 'a0000001-0000-4000-8000-000000000001',
    key: 'UKM',
    startedAt: '2026-09-28 14:03:10',
    ringSeconds: 12,
    talkSeconds: 230,
    caller: '075586001234',
    callee: '+447700900123',
    hangupCause: 'NORMAL_CLEARING',
  },
  {
    callUuid: 'a0000001-0000-4000-8000-000000000002',
    key: 'JM',
    startedAt: '2026-09-28 14:10:00',
    ringSeconds: 5,
    talkSeconds: 1,
    caller: '075586001234',
    callee: '+18765550100',
    hangupCause: 'NORMAL_CLEARING',
  },
];
const plan = () =>
  planAbc001Calls({
    tenantCode: 'ABC001',
    entries,
    fixedCalls,
    caller: '075586001234',
  });

// 设计稿国家表（客户门户 第二批.dc.html:595）折叠后：英国手机并入英国。单位：[通话数, 计费分钟, 费用（分）]。
const MOCKUP_COUNTRIES = {
  '2026-08': {
    中国: [7350, 28803, 144015],
    牙买加: [145, 700, 17500],
    英国: [580 + 212, 2000 + 900, 9000 + 1800],
    日本: [540, 2000, 7000],
    中国香港: [384, 1400, 4200],
    新加坡: [318, 1200, 3360],
    '美国/加拿大': [113, 465, 465],
  },
  '2026-09': {
    中国: [9820, 38476, 192380],
    牙买加: [186, 900, 22500],
    英国: [812 + 236, 2800 + 1000, 12600 + 2000],
    日本: [704, 2600, 9100],
    中国香港: [466, 1700, 5100],
    新加坡: [398, 1500, 4200],
    '美国/加拿大': [182, 750, 750],
  },
} as const;

const monthOf = (call: PlannedCall) => call.day.slice(0, 7);
const cents = (value: string) => decimal(value).times(100).toFixed();

describe('ABC001 逐通话单种子', () => {
  const calls = plan();

  it('8、9 月的通话数、分钟与费用等于设计稿', () => {
    for (const [month, calls_, minutes, charge] of [
      ['2026-08', 9642, 37468, '1873.4'],
      ['2026-09', 12804, 49726, '2486.3'],
    ] as const) {
      const rows = calls.filter((c) => monthOf(c) === month);
      expect(rows).toHaveLength(calls_);
      expect(rows.reduce((sum, c) => sum + c.billedMinutes, 0)).toBe(minutes);
      expect(
        rows.reduce((sum, c) => sum.plus(c.charge), decimal('0')).toFixed(),
      ).toBe(charge);
    }
  });

  it('国家表逐项相等（按国家折叠，不含说明）', () => {
    for (const month of ['2026-08', '2026-09'] as const) {
      const grouped = new Map<string, [number, number, string]>();
      for (const call of calls.filter((c) => monthOf(c) === month)) {
        const row = grouped.get(call.country) ?? [0, 0, '0'];
        grouped.set(call.country, [
          row[0] + 1,
          row[1] + call.billedMinutes,
          decimal(row[2]).plus(call.charge).toFixed(),
        ]);
      }
      expect(
        Object.fromEntries(
          [...grouped].map(([country, [n, m, charge]]) => [
            country,
            [n, m, Number(cents(charge))],
          ]),
        ),
      ).toEqual(MOCKUP_COUNTRIES[month]);
    }
  });

  it('日表逐日相等：通话数、计费分钟与费用，没有空日', () => {
    for (const [month, rows] of [
      ['2026-08', AUGUST_DAYS],
      ['2026-09', SEPTEMBER_DAYS],
    ] as const) {
      for (const [day, fee, minutes, count] of rows) {
        const date = `${month}-${String(day).padStart(2, '0')}`;
        const sameDay = calls.filter((c) => c.day === date);
        expect(sameDay.length, date).toBe(count);
        expect(
          sameDay.reduce((sum, c) => sum + c.billedMinutes, 0),
          date,
        ).toBe(minutes);
        expect(
          cents(
            sameDay
              .reduce((sum, c) => sum.plus(c.charge), decimal('0'))
              .toFixed(),
          ),
          date,
        ).toBe(String(fee));
      }
    }
  });

  it('9 月 23 至 28 日沿用旧种子的日费用，9 月 29 日 42.10', () => {
    const feeOf = (date: string) =>
      calls
        .filter((c) => c.day === date)
        .reduce((sum, c) => sum.plus(c.charge), decimal('0'))
        .toFixed();
    expect(
      [23, 24, 25, 26, 27, 28, 29].map((d) => feeOf(`2026-09-${d}`)),
    ).toEqual(['86.05', '83.48', '90.12', '85.9', '81.27', '88.64', '42.1']);
  });

  it('确定性：两次计划逐字节相同，UUID 不重复', () => {
    expect(JSON.stringify(plan())).toBe(JSON.stringify(calls));
    expect(new Set(calls.map((c) => c.callUuid)).size).toBe(calls.length);
  });

  it('每通都在接通当天结束，开户日在开户之后，9-29 在 14:03:22 之前', () => {
    for (const call of calls) {
      expect(call.answeredAt.getTime()).toBeGreaterThanOrEqual(
        call.startedAt.getTime(),
      );
      const endDay = new Date(call.endedAt.getTime() + 8 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      expect(endDay, call.callUuid).toBe(call.day);
      expect(call.billedMinutes).toBeGreaterThanOrEqual(1);
    }
    const opening = beijingTime('2026-08-12 09:30:00').getTime();
    expect(
      Math.min(
        ...calls
          .filter((c) => c.day === '2026-08-12')
          .map((c) => c.startedAt.getTime()),
      ),
    ).toBeGreaterThan(opening);
    const cutoff = beijingTime('2026-09-29 14:03:22').getTime();
    expect(
      Math.max(
        ...calls
          .filter((c) => c.day === '2026-09-29')
          .map((c) => c.endedAt.getTime()),
      ),
    ).toBeLessThan(cutoff + 60 * 60_000);
    expect(
      Math.max(
        ...calls
          .filter((c) => c.day === '2026-09-29')
          .map((c) => c.answeredAt.getTime()),
      ),
    ).toBeLessThan(cutoff);
  });

  it('并入的示例话单保留 UUID、时间与费用', () => {
    const uk = calls.find((c) => c.callUuid === fixedCalls[0]!.callUuid)!;
    const jm = calls.find((c) => c.callUuid === fixedCalls[1]!.callUuid)!;
    expect(uk).toMatchObject({
      day: '2026-09-28',
      billedMinutes: 4,
      charge: '0.18',
      country: '英国',
      description: '手机',
      billingNumber: '447700900123',
    });
    expect(jm).toMatchObject({
      day: '2026-09-28',
      billedMinutes: 1,
      charge: '0.25',
      country: '牙买加',
    });
    expect(uk.answeredAt).toEqual(beijingTime('2026-09-28 14:03:22'));
  });

  it('每通的费用等于计费分钟乘费率', () => {
    for (const call of calls) {
      expect(
        decimal(call.charge).eq(
          decimal(call.perMinute).times(call.billedMinutes),
        ),
        call.callUuid,
      ).toBe(true);
    }
  });

  it('分配算法在输入合计不一致时报错而不是静默偏差', () => {
    expect(() =>
      allocateMonth(AUGUST_DAYS, {
        CN: [7350, 28803],
        JM: [145, 700],
        UKM: [580, 2001],
        JP: [540, 2000],
        HK: [384, 1400],
        SG: [318, 1200],
        UK: [212, 900],
        US: [113, 465],
      }),
    ).toThrow();
  });
});
