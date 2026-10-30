import { describe, expect, it } from 'vitest';
import { modJsonCdrSchema } from '@fs-billing/shared';
import { money, rate } from '@fs-billing/rating';
import {
  buildCdr,
  callUuid,
  fitsSpend,
  shanghaiDate,
  planDay,
} from './generate-cdrs.js';

describe('synthetic CDRs', () => {
  it('builds an ingestible answered and unanswered FreeSWITCH payload', () => {
    for (const billsec of [0, 61]) {
      const payload = buildCdr({
        uuid: callUuid('7', 'tenant', '2026-10-02', 0),
        tenant: 'ABC',
        caller: '1001',
        number: '8613800000000',
        start: 1790902800,
        billsec,
        ring: 5,
      });
      const parsed = modJsonCdrSchema.parse(payload);
      expect(parsed.tenantTag).toBe('ABC');
      expect(parsed.callee).toBe('+8613800000000');
      expect(parsed.billingNumber).toBe('8613800000000');
      expect(parsed.billsec).toBe(billsec);
      expect(parsed.answeredAt === null).toBe(billsec === 0);
      expect(parsed.hangupCause).toBe(
        billsec ? 'NORMAL_CLEARING' : 'NO_ANSWER',
      );
    }
  });
  it('uses Shanghai business dates across UTC midnight', () => {
    expect(shanghaiDate(new Date('2026-10-01T15:59:59Z'))).toBe('2026-10-01');
    expect(shanghaiDate(new Date('2026-10-01T16:00:00Z'))).toBe('2026-10-02');
  });
  it('plans calls on the requested Shanghai date and before now', () => {
    const tenant = {
      code: 'ABC',
      status: 'active' as const,
      currency: 'CNY' as const,
      balance: money('CNY', '100'),
      overdraft: money('CNY', '0'),
      rates: {
        currency: 'CNY' as const,
        versions: [
          {
            effectiveFrom: new Date('2020-01-01T00:00:00Z'),
            entries: [
              {
                prefix: '86',
                country: 'CN',
                iso: 'CN',
                description: '',
                perMinute: rate('CNY', '0.1'),
              },
            ],
          },
        ],
      },
    };
    const now = Date.parse('2026-10-02T06:00:00Z');
    const calls = planDay(
      tenant,
      'tenant',
      '1001',
      '2026-10-02',
      '1',
      100,
      100,
      now,
    );
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const start = new Date(Number(call.body.variables.start_epoch) * 1000);
      expect(shanghaiDate(start)).toBe('2026-10-02');
      expect(Number(call.body.variables.end_epoch) * 1000).toBeLessThanOrEqual(
        now,
      );
      expect((start.getUTCHours() + 8) % 24).toBeGreaterThanOrEqual(9);
      expect(modJsonCdrSchema.safeParse(call.body).success).toBe(true);
    }
  });
  it('derives stable distinct UUIDs', () => {
    const uuid = callUuid('1', 'tenant', '2026-10-02', 0);
    expect(uuid).toBe(callUuid('1', 'tenant', '2026-10-02', 0));
    expect(uuid).not.toBe(callUuid('2', 'tenant', '2026-10-02', 0));
    expect(uuid).not.toBe(callUuid('1', 'tenant', '2026-10-02', 1));
  });
  it('enforces the cap using decimal arithmetic', () => {
    expect(fitsSpend('0.1', '0.2', '0.3')).toBe(true);
    expect(fitsSpend('0.1', '0.2001', '0.3')).toBe(false);
  });
});
