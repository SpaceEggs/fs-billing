import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApiContract,
  adminBalanceOperationRequestSchema,
  adminCurrencyTotalsSchema,
  adminRatePreviewResponseSchema,
  adminRateScheduleSchema,
  adminRateEntriesSchema,
  adminTenantCreateRequestSchema,
  adminTenantEditRequestSchema,
  adminTenantsQuerySchema,
  auditPayloadSchema,
} from './index.js';
import { apiContract } from '../contract.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const balanceInput = {
  currency: 'CNY',
  idempotencyKey: 'manual:001',
  amount: '-10.00',
  kind: 'adjustment',
};
afterEach(() => vi.useRealTimers());

describe('admin balance contract', () => {
  it('adjustment requires a nonblank reason and a nonzero signed amount', () => {
    for (const reason of [undefined, '', '   ']) {
      expect(
        adminBalanceOperationRequestSchema.safeParse({
          ...balanceInput,
          reason,
        }).success,
      ).toBe(false);
    }
    expect(
      adminBalanceOperationRequestSchema.parse({
        ...balanceInput,
        reason: ' 冲正重复充值 ',
      }),
    ).toEqual({ ...balanceInput, reason: '冲正重复充值' });
    expect(
      adminBalanceOperationRequestSchema.safeParse({
        ...balanceInput,
        amount: '0.000',
        reason: '冲正',
      }).success,
    ).toBe(false);
    expect(
      adminBalanceOperationRequestSchema.safeParse({
        ...balanceInput,
        amount: '10.00',
        reason: '补正',
      }).success,
    ).toBe(true);
  });
  it('topup, credit_topup and gift accept only positive decimal strings', () => {
    for (const kind of ['topup', 'credit_topup', 'gift']) {
      for (const amount of ['-1', '0', 500, '1e3', 'NaN']) {
        expect(
          adminBalanceOperationRequestSchema.safeParse({
            ...balanceInput,
            kind,
            amount,
          }).success,
        ).toBe(false);
      }
      expect(
        adminBalanceOperationRequestSchema.safeParse({
          ...balanceInput,
          kind,
          amount: '500.00',
        }).success,
      ).toBe(true);
    }
  });
  it('credit notes have a separate internal-only field', () => {
    expect(
      adminBalanceOperationRequestSchema.parse({
        ...balanceInput,
        kind: 'credit_topup',
        amount: '500.00',
        internalNote: '合同账期',
      }),
    ).toEqual({
      ...balanceInput,
      kind: 'credit_topup',
      amount: '500.00',
      internalNote: '合同账期',
    });
    expect(
      adminBalanceOperationRequestSchema.safeParse({
        ...balanceInput,
        kind: 'credit_topup',
        amount: '500.00',
        note: '泄露',
      }).success,
    ).toBe(false);
  });
});

describe('admin rate contract', () => {
  it('scheduled effectiveFrom rejects past and accepts equality at request time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-14T10:00:00.000Z'));
    expect(
      adminRateScheduleSchema.safeParse({
        kind: 'scheduled',
        effectiveFrom: '2026-10-14T09:59:59.999Z',
      }).success,
    ).toBe(false);
    expect(
      adminRateScheduleSchema.parse({
        kind: 'scheduled',
        effectiveFrom: '2026-10-14T18:00:00.000+08:00',
      }),
    ).toEqual({
      kind: 'scheduled',
      effectiveFrom: '2026-10-14T18:00:00.000+08:00',
    });
    const future = {
      kind: 'scheduled',
      effectiveFrom: '2026-10-14T10:00:01.000Z',
    };
    expect(adminRateScheduleSchema.safeParse(future).success).toBe(true);
    vi.advanceTimersByTime(1001);
    expect(adminRateScheduleSchema.safeParse(future).success).toBe(false);
    expect(adminRateScheduleSchema.parse({ kind: 'immediate' })).toEqual({
      kind: 'immediate',
    });
    expect(
      adminRateScheduleSchema.safeParse({
        kind: 'immediate',
        effectiveFrom: '2020-01-01T00:00:00Z',
      }).success,
    ).toBe(false);
  });
  it('CSV failure retains every physical line and cannot carry a commit token', () => {
    const result = {
      ok: false,
      errors: [
        { line: 12, reason: '前缀只能是数字' },
        { line: 37, reason: '费率不能为负' },
        { line: 45, reason: '前缀重复' },
      ],
    };
    expect(adminRatePreviewResponseSchema.parse(result)).toEqual(result);
    expect(
      adminRatePreviewResponseSchema.safeParse({ ...result, previewId: id })
        .success,
    ).toBe(false);
    expect(
      adminRatePreviewResponseSchema.safeParse({ ok: false, errors: [] })
        .success,
    ).toBe(false);
    expect(
      adminRatePreviewResponseSchema.safeParse({
        ok: false,
        errors: [{ line: 0, reason: 'bad' }],
      }).success,
    ).toBe(false);
  });
  it('rate entries reject duplicate prefixes, international crown and excess decimals', () => {
    const entry = { prefix: '447', country: '英国手机', rate: '0.0450' };
    expect(adminRateEntriesSchema.parse([entry])).toEqual([entry]);
    expect(adminRateEntriesSchema.safeParse([entry, entry]).success).toBe(
      false,
    );
    expect(
      adminRateEntriesSchema.safeParse([{ ...entry, rate: '0.04501' }]).success,
    ).toBe(false);
    expect(
      adminRateEntriesSchema.safeParse([{ ...entry, prefix: '00447' }]).success,
    ).toBe(false);
  });
});

it('currency totals keep CNY and USD separate and reject a combined total', () => {
  expect(
    adminCurrencyTotalsSchema.parse({ CNY: '6300.00', USD: '400.00' }),
  ).toEqual({ CNY: '6300.00', USD: '400.00' });
  expect(
    adminCurrencyTotalsSchema.safeParse({
      CNY: '6300.00',
      USD: '400.00',
      total: '6700.00',
    }).success,
  ).toBe(false);
  expect(adminCurrencyTotalsSchema.safeParse({ CNY: '6300.00' }).success).toBe(
    false,
  );
});
it('tenant edits cannot change currency or code; creation uses an immediate first version', () => {
  expect(
    adminTenantEditRequestSchema.safeParse({ name: '客户', code: 'ABC001' })
      .success,
  ).toBe(false);
  expect(
    adminTenantEditRequestSchema.safeParse({ name: '客户', currency: 'USD' })
      .success,
  ).toBe(false);
  const request = {
    name: '客户',
    code: 'ABC001',
    currency: 'CNY',
    settings: { lowBalanceThreshold: '200', emails: [] },
    initialRates: { kind: 'blank' },
  };
  expect(adminTenantCreateRequestSchema.safeParse(request).success).toBe(true);
  expect(
    adminTenantCreateRequestSchema.safeParse({
      ...request,
      effectiveFrom: '2099-01-01T00:00:00Z',
    }).success,
  ).toBe(false);
  expect(adminTenantsQuerySchema.parse({})).toEqual({
    page: 1,
    pageSize: 25,
    sort: 'status_currency_balance',
  });
});
it('planned operations all require admin sessions and leave the live contract unchanged', () => {
  expect(
    Object.values(adminApiContract).every(
      (op) => op.access === 'admin' && op.isolationCase === 'admin-only',
    ),
  ).toBe(true);
  expect('adminTenantCreate' in apiContract).toBe(false);
  expect(adminApiContract.resetAdminPassword.path).toBe(
    apiContract.resetAdminPassword.path,
  );
  expect(adminApiContract.resetPortalAccountPassword.path).toBe(
    apiContract.resetPortalAccountPassword.path,
  );
});
it('audit payload requires actor, time, target and content and excludes credentials', () => {
  const payload = {
    id,
    action: 'balance_adjustment',
    actor: { id, name: '王敏' },
    occurredAt: '2026-10-14T10:00:00Z',
    tenantId: id,
    target: { kind: 'ledger_entry', id },
    content: {
      summary: '调账',
      changes: [],
      ledgerEntryId: id,
      reason: '冲正',
    },
  };
  expect(auditPayloadSchema.parse(payload)).toEqual(payload);
  expect(
    auditPayloadSchema.safeParse({
      ...payload,
      content: { ...payload.content, temporaryPassword: 'secret' },
    }).success,
  ).toBe(false);
  expect(
    auditPayloadSchema.safeParse({ ...payload, actor: undefined }).success,
  ).toBe(false);
});
