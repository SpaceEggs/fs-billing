import { describe, expect, it } from 'vitest';
import {
  adminRateEditRequestSchema,
  adminRateEntriesSchema,
  adminTenantCreateRequestSchema,
} from './index.js';

describe('rate CSV text validation', () => {
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
