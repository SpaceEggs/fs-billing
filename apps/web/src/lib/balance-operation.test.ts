import { describe, expect, it } from 'vitest';
import { adminBalanceOperationRequestSchema } from '@fs-billing/shared';
import {
  balanceFieldErrors,
  balanceRequest,
  draftFingerprint,
  needsLargeAmountConfirm,
  projectBalance,
  validateBalanceDraft,
  type BalanceKind,
} from './balance-operation';
import { normalizeAmountInput } from './amounts';

const draft = (kind: BalanceKind, amount: string, note = '') => ({
  kind,
  amount,
  note,
});

describe('balance amount validation', () => {
  it.each(['topup', 'credit_topup', 'gift'] as const)(
    '%s accepts two decimals and ten integer digits only',
    (kind) => {
      expect(validateBalanceDraft(draft(kind, '500.25'))).toEqual({});
      expect(validateBalanceDraft(draft(kind, '9999999999.99'))).toEqual({});
      expect(validateBalanceDraft(draft(kind, '10000000000'))).toEqual({
        amount: '金额须为数字，最多 10 位整数、2 位小数',
      });
      expect(validateBalanceDraft(draft(kind, '1.234'))).toEqual({
        amount: '金额须为数字，最多 10 位整数、2 位小数',
      });
      expect(validateBalanceDraft(draft(kind, '0'))).toEqual({
        amount: '金额必须大于 0',
      });
      expect(validateBalanceDraft(draft(kind, '-5'))).toEqual({
        amount: '金额必须大于 0',
      });
      expect(validateBalanceDraft(draft(kind, ''))).toEqual({
        amount: '请输入金额',
      });
      expect(validateBalanceDraft(draft(kind, '12abc'))).toEqual({
        amount: '金额须为数字，最多 10 位整数、2 位小数',
      });
    },
  );

  it('adjustment accepts four signed decimals and rejects zero', () => {
    expect(
      validateBalanceDraft(draft('adjustment', '-20.1234', '冲正')),
    ).toEqual({});
    expect(validateBalanceDraft(draft('adjustment', '0.0001', '补差'))).toEqual(
      {},
    );
    expect(
      validateBalanceDraft(draft('adjustment', '-9999999999.9999', '冲正')),
    ).toEqual({});
    expect(
      validateBalanceDraft(draft('adjustment', '1.23456', '补差')),
    ).toEqual({ amount: '金额须为数字，最多 10 位整数、4 位小数' });
    expect(
      validateBalanceDraft(draft('adjustment', '-0.0000', '补差')),
    ).toEqual({ amount: '调账金额不能为 0' });
  });

  it('adjustment requires a nonblank reason; other kinds do not', () => {
    expect(validateBalanceDraft(draft('adjustment', '-20', ''))).toEqual({
      note: '调账必须填写备注',
    });
    expect(validateBalanceDraft(draft('adjustment', '-20', '  \n '))).toEqual({
      note: '调账必须填写备注',
    });
    expect(validateBalanceDraft(draft('gift', '20', ''))).toEqual({});
  });

  it('normalizes thousands separators, a plus sign and leading zeros', () => {
    expect(normalizeAmountInput(' 1,000.50 ')).toBe('1000.50');
    expect(normalizeAmountInput('+0500')).toBe('500');
    expect(normalizeAmountInput('-007.5')).toBe('-7.5');
    expect(validateBalanceDraft(draft('topup', '1,000.50'))).toEqual({});
  });
});

describe('balance requests', () => {
  it('puts the note in the field each kind uses and passes the contract', () => {
    const cases = [
      [draft('topup', '500', ' 招行 '), { note: '招行' }],
      [draft('credit_topup', '500', '月结'), { internalNote: '月结' }],
      [draft('gift', '20', ''), { note: '' }],
      [draft('adjustment', '-20', '冲正重复赠送'), { reason: '冲正重复赠送' }],
    ] as const;
    for (const [input, note] of cases) {
      const body = balanceRequest(input, 'CNY', 'web:key-1');
      expect(body).toEqual({
        kind: input.kind,
        currency: 'CNY',
        idempotencyKey: 'web:key-1',
        amount: input.amount,
        ...note,
      });
      expect(adminBalanceOperationRequestSchema.safeParse(body).success).toBe(
        true,
      );
    }
  });

  it('fingerprints only the submitted content', () => {
    expect(draftFingerprint(draft('gift', '1,000', ' a '))).toBe(
      draftFingerprint(draft('gift', '1000', 'a')),
    );
    expect(draftFingerprint(draft('gift', '1000', 'a'))).not.toBe(
      draftFingerprint(draft('gift', '1000.01', 'a')),
    );
    expect(draftFingerprint(draft('gift', '1000', 'a'))).not.toBe(
      draftFingerprint(draft('credit_topup', '1000', 'a')),
    );
  });

  it('maps server field issues to the dialog fields', () => {
    expect(
      balanceFieldErrors([
        { path: ['amount'], message: '金额最多 8 位整数' },
        { path: ['reason'], message: '原因过长' },
        { path: ['currency'], message: '币种不符' },
      ]),
    ).toEqual({
      amount: '金额最多 8 位整数',
      note: '原因过长',
      form: '币种不符',
    });
  });
});

describe('large amount confirmation', () => {
  const defaults = { CNY: '10000', USD: '1500' };

  it('applies to gift and credit strictly above the currency threshold', () => {
    for (const kind of ['gift', 'credit_topup'] as const) {
      expect(needsLargeAmountConfirm(kind, '10000', 'CNY', defaults)).toBe(
        false,
      );
      expect(needsLargeAmountConfirm(kind, '10000.00', 'CNY', defaults)).toBe(
        false,
      );
      expect(needsLargeAmountConfirm(kind, '10000.01', 'CNY', defaults)).toBe(
        true,
      );
      expect(needsLargeAmountConfirm(kind, '1500', 'USD', defaults)).toBe(
        false,
      );
      expect(needsLargeAmountConfirm(kind, '1500.01', 'USD', defaults)).toBe(
        true,
      );
    }
  });

  it('does not apply to recharge or adjustment', () => {
    expect(needsLargeAmountConfirm('topup', '99999', 'CNY', defaults)).toBe(
      false,
    );
    expect(
      needsLargeAmountConfirm('adjustment', '99999', 'CNY', defaults),
    ).toBe(false);
  });

  it('follows a configured threshold', () => {
    const configured = { CNY: '500', USD: '1500' };
    expect(needsLargeAmountConfirm('gift', '500', 'CNY', configured)).toBe(
      false,
    );
    expect(needsLargeAmountConfirm('gift', '500.01', 'CNY', configured)).toBe(
      true,
    );
    expect(needsLargeAmountConfirm('gift', '1,000', 'CNY', configured)).toBe(
      true,
    );
  });
});

describe('projected balance', () => {
  const tenant = {
    status: 'active' as const,
    balance: '-35.2',
    overdraftLimit: '100',
    settings: { overdraftLimit: '100', lowBalanceThreshold: '200', emails: [] },
  };

  it('uses decimal arithmetic and the server health order', () => {
    expect(projectBalance(tenant, '500')).toEqual({
      balance: '464.8',
      available: '564.8',
      health: 'normal',
    });
    expect(projectBalance(tenant, '0.1')).toEqual({
      balance: '-35.1',
      available: '64.9',
      health: 'overdraft',
    });
    expect(projectBalance(tenant, '-64.8')).toEqual({
      balance: '-100',
      available: '0',
      health: 'suspended',
    });
    expect(projectBalance(tenant, '235.1999')).toEqual({
      balance: '199.9999',
      available: '299.9999',
      health: 'low_balance',
    });
  });

  it('keeps a disabled tenant disabled', () => {
    expect(
      projectBalance({ ...tenant, status: 'disabled' }, '500').health,
    ).toBe('disabled');
  });
});
