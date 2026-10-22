import { describe, expect, it } from 'vitest';
import {
  calleeProblem,
  cdrListQuery,
  validateCdrFilters,
  validateCdrPage,
  validateCdrRange,
  validatePortalCdrsSearch,
} from './cdr-search';

describe('validatePortalCdrsSearch', () => {
  it('keeps valid parameters and drops each invalid one on its own', () => {
    expect(
      validatePortalCdrsSearch({
        from: '2026-09-01',
        to: '2026-09-29',
        callee: '+44 7700',
        country: '英国',
        status: 'all',
        page: 3,
      }),
    ).toEqual({
      from: '2026-09-01',
      to: '2026-09-29',
      callee: '+44 7700',
      country: '英国',
      status: 'all',
      page: 3,
    });
    expect(
      validatePortalCdrsSearch({
        from: '2026-13-01',
        to: '2026-09-29',
        status: 'bogus',
        country: '   ',
        page: 'abc',
      }),
    ).toEqual({
      from: undefined,
      to: '2026-09-29',
      callee: undefined,
      country: undefined,
      status: undefined,
      page: undefined,
    });
  });

  it('never carries the admin-only unverified filter into the portal', () => {
    expect(
      Object.keys(validatePortalCdrsSearch({ unverifiedOnly: true })),
    ).not.toContain('unverifiedOnly');
  });
});

describe('validateCdrFilters', () => {
  it('reads a numeric callee that the router parsed as a number back as text', () => {
    expect(validateCdrFilters({ callee: 447700900123 }).callee).toBe(
      '447700900123',
    );
  });

  it('accepts only the boolean true for the unverified filter', () => {
    expect(validateCdrFilters({ unverifiedOnly: true }).unverifiedOnly).toBe(
      true,
    );
    expect(
      validateCdrFilters({ unverifiedOnly: 'true' }).unverifiedOnly,
    ).toBeUndefined();
    expect(
      validateCdrFilters({ unverifiedOnly: false }).unverifiedOnly,
    ).toBeUndefined();
  });

  it('keeps the default status out of the address', () => {
    expect(validateCdrFilters({ status: 'answered' }).status).toBeUndefined();
  });
});

describe('validateCdrRange and validateCdrPage', () => {
  it('drops dates that do not exist', () => {
    expect(validateCdrRange({ from: '2026-02-30', to: '2026-02-28' })).toEqual({
      from: undefined,
      to: '2026-02-28',
    });
  });

  it('writes the page only from the second page and within the limit', () => {
    expect(validateCdrPage(1)).toBeUndefined();
    expect(validateCdrPage(2)).toBe(2);
    expect(validateCdrPage(100_000)).toBe(100_000);
    expect(validateCdrPage(100_001)).toBeUndefined();
    expect(validateCdrPage(1.5)).toBeUndefined();
  });
});

describe('calleeProblem', () => {
  it.each(['447700900123', '+44 7700 900123', '(0755) 8600-1234', '0086 138'])(
    'accepts %j',
    (callee) => expect(calleeProblem(callee)).toBeNull(),
  );

  it('accepts no search term', () => {
    expect(calleeProblem(undefined)).toBeNull();
  });

  it.each(['abc', '44a', '0000', '1234567890123456', '44%'])(
    'rejects %j with the API message',
    (callee) =>
      expect(calleeProblem(callee)).toBe(
        '被叫号码只能包含数字、+、空格、连字符和括号',
      ),
  );
});

describe('cdrListQuery', () => {
  const range = { from: '2026-09-01', to: '2026-09-29' };

  it('defaults to the answered view and leaves absent filters out', () => {
    expect(cdrListQuery(range, {})).toEqual({ ...range, status: 'answered' });
  });

  it('carries the callee, country and status of the address', () => {
    expect(
      cdrListQuery(range, {
        callee: '447',
        country: '英国',
        status: 'all',
      }),
    ).toEqual({ ...range, callee: '447', country: '英国', status: 'all' });
  });
});
