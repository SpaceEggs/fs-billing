import { describe, expect, it } from 'vitest';
import {
  balanceFieldErrors,
  balanceKindHint,
  balanceKindLabel,
  ledgerKindLabel,
  validateBalanceDraft,
  type BalanceKind,
} from './balance-operation';

const draft = (kind: BalanceKind, amount: string, note = '') => ({
  kind,
  amount,
  note,
});

describe('balance operation labels (English)', () => {
  it('names each operation and ledger kind in English', () => {
    expect(balanceKindLabel('topup', 'en')).toBe('Recharge');
    expect(balanceKindLabel('credit_topup', 'en')).toBe('Credit recharge');
    expect(balanceKindLabel('gift', 'en')).toBe('Gift');
    expect(balanceKindLabel('adjustment', 'en')).toBe('Adjustment');
    expect(balanceKindHint('credit_topup', 'en')).toBe(
      'Positive amounts only; recorded as receivable',
    );
    expect(ledgerKindLabel('credit_recharge', 'en')).toBe('Credit recharge');
    expect(ledgerKindLabel('call_charge', 'en')).toBe('Call charges');
  });

  it('validates amounts and notes in English', () => {
    expect(validateBalanceDraft(draft('topup', ''), 'en')).toEqual({
      amount: 'Enter an amount',
    });
    expect(validateBalanceDraft(draft('topup', '0'), 'en')).toEqual({
      amount: 'Amount must be greater than 0',
    });
    expect(
      validateBalanceDraft(draft('adjustment', '-0.0000', 'x'), 'en'),
    ).toEqual({ amount: 'Adjustment amount cannot be 0' });
    expect(validateBalanceDraft(draft('adjustment', '-20', ''), 'en')).toEqual({
      note: 'Adjustments require a note',
    });
    expect(validateBalanceDraft(draft('topup', '1.234'), 'en')).toEqual({
      amount:
        'Amount must be a number with at most 10 integer digits and 2 decimal places',
    });
  });

  it('maps server issues through the English catalog keys', () => {
    expect(
      balanceFieldErrors(
        [
          {
            path: ['amount'],
            key: 'admin:balance.amountRequired',
            message: '',
          },
          {
            path: ['reason'],
            key: 'admin:balance.adjustmentNoteRequired',
            message: '',
          },
        ],
        'en',
      ),
    ).toEqual({
      amount: 'Enter an amount',
      note: 'Adjustments require a note',
    });
  });
});
