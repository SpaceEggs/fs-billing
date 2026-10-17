import { describe, expect, it } from 'vitest';
import {
  adminRateEditRequestSchema,
  adminRateEntriesSchema,
  adminTenantCreateRequestSchema,
  adminCsvBase64Length,
  createAdminCsvFileSchema,
  adminRateScheduleShapeSchema,
  createAdminRateScheduleSchema,
} from './index.js';

describe('rate CSV text validation', () => {
  it('derives file limits from the same base64 length calculation at every padding boundary', () => {
    for (const limit of [1, 2, 3, 4, 5, 6, 1024]) {
      const atLimit = Buffer.alloc(limit).toString('base64');
      const aboveLimit = Buffer.alloc(limit + 1).toString('base64');
      expect(adminCsvBase64Length(limit)).toBe(atLimit.length);
      const schema = createAdminCsvFileSchema(limit);
      expect(
        schema.safeParse({ filename: 'rates.csv', contentBase64: atLimit })
          .success,
      ).toBe(true);
      expect(
        schema.safeParse({ filename: 'rates.csv', contentBase64: aboveLimit })
          .success,
      ).toBe(false);
    }
  });

  it('shares the persisted schedule shape while checking current time only for live requests', () => {
    const past = {
      kind: 'scheduled',
      effectiveFrom: '2000-01-01T00:00:00+08:00',
    };
    expect(adminRateScheduleShapeSchema.parse(past)).toEqual(past);
    expect(createAdminRateScheduleSchema().safeParse(past).success).toBe(false);
    for (const effectiveFrom of ['not-a-date', '2026-10-17T00:00:00']) {
      expect(
        adminRateScheduleShapeSchema.safeParse({ ...past, effectiveFrom })
          .success,
      ).toBe(false);
    }
  });
  it.each(['英\n国', '英\r国', '英\r\n国', '\n英国', '英国\r'])(
    'rejects CR/LF in country before trimming: %j',
    (country) => {
      const entry = { prefix: '44', country, rate: '0.0400' };
      expect(adminRateEntriesSchema.safeParse([entry]).success).toBe(false);
      expect(
        adminRateEditRequestSchema.safeParse({
          baseVersionId: '550e8400-e29b-41d4-a716-446655440000',
          entry,
          schedule: { kind: 'immediate' },
        }).success,
      ).toBe(false);
      expect(
        adminTenantCreateRequestSchema.safeParse({
          code: 'CSVTEST',
          name: 'CSV test',
          currency: 'CNY',
          contactName: '',
          contactPhone: '',
          remark: '',
          settings: { lowBalanceThreshold: '10' },
          initialRates: { kind: 'entries', entries: [entry] },
        }).success,
      ).toBe(false);
    },
  );

  it('accepts CSV quoting characters and trims ordinary whitespace', () => {
    const entry = { prefix: '44', country: ' 英国,"手机" ', rate: '0.0400' };
    expect(adminRateEntriesSchema.parse([entry])).toEqual([
      { ...entry, country: '英国,"手机"' },
    ]);
  });
});
