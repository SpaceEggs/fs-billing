import { expect, test } from 'vitest';
import { formatCountryLabel } from './cdr-fields.js';
import { portalCdrSchema } from './portal/cdrs.js';
import { adminCdrSchema } from './admin/cdrs.js';

const cdr = {
  callUuid: '550e8400-e29b-41d4-a716-446655440000',
  startedAt: '2026-10-01T00:00:00Z',
  answeredAt: '2026-10-01T00:00:01Z',
  endedAt: '2026-10-01T00:01:01Z',
  caller: '123',
  callee: '44712345678',
  iso: 'GB',
  country: '英国',
  description: '手机',
  matchedPrefix: '447',
  durationSeconds: 60,
  billedMinutes: '1',
  rate: '0.045',
  charge: '0.045',
  hangupCause: 'NORMAL_CLEARING',
};
test('formatCountryLabel joins country and description', () => {
  expect(formatCountryLabel('英国', '手机')).toBe('英国 · 手机');
});
test.each([null, undefined, '', '  '])(
  'formatCountryLabel drops empty or blank description %j',
  (description) => {
    expect(formatCountryLabel('英国', description)).toBe('英国');
  },
);
test('portal and admin CDRs require iso and description keys', () => {
  for (const key of ['iso', 'description']) {
    const incomplete = Object.fromEntries(
      Object.entries(cdr).filter(([name]) => name !== key),
    );
    expect(portalCdrSchema.safeParse(incomplete).success).toBe(false);
    expect(
      adminCdrSchema.safeParse({ ...incomplete, unverified: false }).success,
    ).toBe(false);
  }
});
test.each(['GB', null, 'gb', 'GBR', ''])(
  'CDR ISO must be uppercase or null: %j',
  (iso) => {
    const valid = iso === 'GB' || iso === null;
    expect(portalCdrSchema.safeParse({ ...cdr, iso }).success).toBe(valid);
    expect(
      adminCdrSchema.safeParse({ ...cdr, iso, unverified: false }).success,
    ).toBe(valid);
  },
);
