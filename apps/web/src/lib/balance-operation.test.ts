import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminBalanceOperationRequestSchema } from '@fs-billing/shared';
import {
  balanceFieldErrors,
  balanceRequest,
  beginBalanceAttempt,
  clearBalanceAttempts,
  draftFingerprint,
  needsLargeAmountConfirm,
  projectBalance,
  resolveBalanceAttempt,
  unresolvedBalanceAttempts,
  validateBalanceDraft,
  type BalanceDraft,
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

  it('fingerprints only the submitted content', async () => {
    const fingerprint = draftFingerprint;
    const base = await fingerprint('t1', draft('gift', '1000', 'a'));
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprint('t1', draft('gift', '1,000', ' a '))).toBe(base);
    expect(await fingerprint('t1', draft('gift', '1000.01', 'a'))).not.toBe(
      base,
    );
    expect(
      await fingerprint('t1', draft('credit_topup', '1000', 'a')),
    ).not.toBe(base);
    expect(await fingerprint('t2', draft('gift', '1000', 'a'))).not.toBe(base);
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

describe('balance attempts', () => {
  const a = draft('adjustment', '-12.3456', '冲正重复赠送');
  const b = draft('gift', '888.88', '春节回馈');

  afterEach(() => {
    vi.restoreAllMocks();
    clearBalanceAttempts();
  });

  async function begin(owner: string, tenantId: string, content: BalanceDraft) {
    const attempt = await beginBalanceAttempt(owner, tenantId, content);
    if (!attempt) throw new Error('attempt went stale');
    return attempt;
  }

  /** 让下一次指纹计算停在摘要处，直到调用返回的 release。 */
  function holdNextDigest() {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let release = () => {};
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(
      (...args) =>
        new Promise((resolve) => {
          release = () => resolve(digest(...args));
        }),
    );
    return () => release();
  }

  it('reuses the key of an unresolved attempt until it resolves', async () => {
    const first = await begin('admin-1', 't1', a);
    expect(first.key).toMatch(/^web:/);
    expect((await begin('admin-1', 't1', a)).key).toBe(first.key);
    resolveBalanceAttempt(first);
    expect((await begin('admin-1', 't1', a)).key).not.toBe(first.key);
  });

  it('keeps an unknown attempt when a different one is rejected', async () => {
    const unknown = await begin('admin-1', 't1', a);
    const rejected = await begin('admin-1', 't1', b);
    expect(rejected.key).not.toBe(unknown.key);
    resolveBalanceAttempt(rejected);
    expect((await begin('admin-1', 't1', a)).key).toBe(unknown.key);
  });

  it('logout clears unresolved attempts', async () => {
    const before = await begin('admin-1', 't1', a);
    clearBalanceAttempts();
    expect(unresolvedBalanceAttempts()).toBeNull();
    expect((await begin('admin-1', 't1', a)).key).not.toBe(before.key);
  });

  it('does not reuse another admin key', async () => {
    const first = await begin('admin-1', 't1', a);
    const other = await begin('admin-2', 't1', a);
    expect(other.key).not.toBe(first.key);
    expect(unresolvedBalanceAttempts()).toEqual({
      owner: 'admin-2',
      entries: [[other.fingerprint, other.key]],
    });
    expect((await begin('admin-1', 't1', a)).key).not.toBe(first.key);
  });

  it('stores only fingerprint digests and keys, never amount or note', async () => {
    const first = await begin('admin-1', 't1', a);
    const second = await begin('admin-1', 't1', b);
    const store = unresolvedBalanceAttempts();
    expect(store).toEqual({
      owner: 'admin-1',
      entries: [
        [first.fingerprint, first.key],
        [second.fingerprint, second.key],
      ],
    });
    for (const [fingerprint] of store?.entries ?? [])
      expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(store);
    for (const plaintext of ['12.3456', '冲正重复赠送', '888.88', '春节回馈'])
      expect(serialized).not.toContain(plaintext);
  });

  it('a logout during fingerprinting voids the attempt and keeps the new admin store', async () => {
    const release = holdNextDigest();
    const stale = beginBalanceAttempt('admin-1', 't1', a);
    clearBalanceAttempts();
    const current = await begin('admin-2', 't1', a);
    release();
    expect(await stale).toBeNull();
    expect(unresolvedBalanceAttempts()).toEqual({
      owner: 'admin-2',
      entries: [[current.fingerprint, current.key]],
    });
    expect((await begin('admin-2', 't1', a)).key).toBe(current.key);
  });

  it('an admin switch during fingerprinting voids the earlier admin attempt', async () => {
    await begin('admin-1', 't1', b);
    const release = holdNextDigest();
    const stale = beginBalanceAttempt('admin-1', 't1', a);
    const current = await begin('admin-2', 't1', a);
    release();
    expect(await stale).toBeNull();
    expect(unresolvedBalanceAttempts()).toEqual({
      owner: 'admin-2',
      entries: [[current.fingerprint, current.key]],
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
