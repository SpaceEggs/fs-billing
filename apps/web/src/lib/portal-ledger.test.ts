import { describe, expect, it } from 'vitest';
import { cdrDayHref, validatePortalLedgerSearch } from './portal-ledger';

describe('portal ledger search', () => {
  it('keeps valid values and drops each invalid one on its own', () => {
    expect(
      validatePortalLedgerSearch({
        from: '2026-09-01',
        to: 'nope',
        kind: 'gift',
        page: 3,
      }),
    ).toEqual({
      from: '2026-09-01',
      to: undefined,
      kind: 'gift',
      page: 3,
    });
    expect(
      validatePortalLedgerSearch({ kind: 'credit_recharge', page: 0 }),
    ).toEqual({
      from: undefined,
      to: undefined,
      kind: undefined,
      page: undefined,
    });
  });

  it('leaves page 1 out of the address', () => {
    expect(validatePortalLedgerSearch({ page: 1 }).page).toBeUndefined();
  });

  it('links a merged row to that Beijing day of CDRs', () => {
    expect(cdrDayHref('2026-09-28')).toBe(
      '/portal/cdrs?from=2026-09-28&to=2026-09-28',
    );
  });
});
