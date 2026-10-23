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
import { planAbc01Unassigned } from './seed-unassigned.js';

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
