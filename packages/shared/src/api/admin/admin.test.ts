import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adminApiContract,
  adminMutationResponseSchema,
  adminAuditedMutationResponseSchema,
  adminTenantSettingsRequestSchema,
  adminTenantSettingsResponseSchema,
  adminRateVersionResponseSchema,
  createAdminInputAmountSchemas,
  createAdminRateEntriesSchema,
  createAdminCsvFileSchema,
  adminCsvFileSchema,
  DEFAULT_ADMIN_CSV_MAX_BYTES,
  DEFAULT_ADMIN_RATE_MAX_ROWS,
  DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS,
  adminLedgerEntrySchema,
  adminTenantCopyConsistencySchema,
  adminTenantOverviewResponseSchema,
  adminPortalAccountCreateResponseSchema,
  adminConfirmPaymentRequestSchema,
  adminReceivableSchema,
  portalLedgerEntrySchema,
  projectPortalLedgerEntry,
  adminBalanceOperationRequestSchema,
  adminCurrencyTotalsSchema,
  adminRatePreviewResponseSchema,
  adminRateScheduleSchema,
  adminRateEntriesSchema,
  adminTenantCreateRequestSchema,
  adminTenantEditRequestSchema,
  adminTenantSummarySchema,
  adminTenantDetailResponseSchema,
  adminTenantsQuerySchema,
  auditPayloadSchema,
  auditContentSchema,
  auditActionSchema,
} from './index.js';
import { apiContract } from '../contract.js';
import * as adminSchemas from './index.js';
import { parseRateCsv } from '../../../../rating/src/csv.js';
import { z } from 'zod';

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
it('list summaries expose settingsConfigured and detail still requires settings', () => {
  const summary = {
    id,
    code: 'ABC001',
    name: '客户',
    currency: 'CNY',
    status: 'active',
    health: 'normal',
    settingsConfigured: false,
    balance: '0',
    overdraftLimit: '100',
    availableBalance: '100',
    monthConsumption: '0',
    pendingReceivable: '0',
  };
  expect(adminTenantSummarySchema.parse(summary)).toEqual(summary);
  expect(adminTenantDetailResponseSchema.safeParse(summary).success).toBe(
    false,
  );
  expect(
    adminTenantSummarySchema.safeParse({
      ...summary,
      settingsConfigured: undefined,
    }).success,
  ).toBe(false);
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
      amount: '-10.00',
      currency: 'CNY',
    },
  };
  expect(auditPayloadSchema.parse(payload)).toEqual(payload);
  expect(
    auditPayloadSchema.safeParse({
      ...payload,
      content: { ...payload.content, temporaryPassword: 'secret' },
    }).success,
  ).toBe(false);
  for (const field of ['actor', 'occurredAt', 'target', 'content']) {
    expect(
      auditPayloadSchema.safeParse({ ...payload, [field]: undefined }).success,
    ).toBe(false);
  }
  for (const field of [
    'reason',
    'ledgerEntryId',
    'amount',
    'currency',
    'summary',
    'changes',
  ]) {
    expect(
      auditPayloadSchema.safeParse({
        ...payload,
        content: { ...payload.content, [field]: undefined },
      }).success,
    ).toBe(false);
  }
});

it('manual idempotency keys cannot reserve Worker call charges', () => {
  expect(
    adminBalanceOperationRequestSchema.safeParse({
      ...balanceInput,
      reason: '冲正',
      idempotencyKey: ` call:${id} `,
    }).success,
  ).toBe(false);
});

it('tenant edits require explicit replacement fields and creation defaults emails in the service', () => {
  const edit = { name: '客户', contactName: '', contactPhone: '', remark: '' };
  expect(adminTenantEditRequestSchema.parse(edit)).toEqual(edit);
  for (const field of ['contactName', 'contactPhone', 'remark']) {
    expect(
      adminTenantEditRequestSchema.safeParse({ ...edit, [field]: undefined })
        .success,
    ).toBe(false);
  }
  const create = {
    name: '客户',
    code: 'ABC001',
    currency: 'CNY',
    settings: { lowBalanceThreshold: '200' },
    initialRates: { kind: 'blank' },
  };
  expect(adminTenantCreateRequestSchema.parse(create)).toEqual({
    ...create,
    contactName: '',
    contactPhone: '',
    remark: '',
  });
  expect(
    adminTenantCreateRequestSchema.safeParse({
      ...create,
      portalAccount: { email: 'user@example.com' },
    }).success,
  ).toBe(false);
});

it('tenant creation validates resolved copy ownership and currency', () => {
  const copy = {
    kind: 'copy',
    sourceTenantId: id,
    sourceVersionId: id,
    targetCurrency: 'CNY',
    sourceVersion: { id, tenantId: id, currency: 'CNY' },
  };
  expect(adminTenantCopyConsistencySchema.parse(copy)).toEqual(copy);
  for (const sourceVersion of [
    { ...copy.sourceVersion, tenantId: '550e8400-e29b-41d4-a716-446655440001' },
    { ...copy.sourceVersion, id: '550e8400-e29b-41d4-a716-446655440001' },
    { ...copy.sourceVersion, currency: 'USD' },
  ]) {
    expect(
      adminTenantCopyConsistencySchema.safeParse({ ...copy, sourceVersion })
        .success,
    ).toBe(false);
  }
});

it('CSV countries obey the response limit when validating parsed entries', () => {
  for (const length of [200, 201]) {
    const parsed = parseRateCsv(
      `prefix,country,rate\n44,${'国'.repeat(length)},0.04`,
      'CNY',
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error('CSV fixture failed to parse');
    const wireEntries = parsed.entries.map((entry) => ({
      prefix: entry.prefix,
      country: entry.country,
      rate: entry.perMinute.perMinute.toFixed(4),
    }));
    expect(adminRateEntriesSchema.safeParse(wireEntries).success).toBe(
      length === 200,
    );
  }
});

it('successful preview counts match each change kind', () => {
  const entry = { prefix: '44', country: '英国', rate: '0.04' };
  const preview = {
    ok: true,
    previewId: id,
    expiresAt: '2026-10-14T10:00:00Z',
    currency: 'CNY',
    encoding: 'UTF-8',
    counts: { added: 1, modified: 1, deleted: 1 },
    changes: [
      { kind: 'added', after: entry },
      { kind: 'modified', before: entry, after: entry },
      { kind: 'deleted', before: entry },
    ],
  };
  expect(adminRatePreviewResponseSchema.parse(preview)).toEqual(preview);
  for (const kind of ['added', 'modified', 'deleted']) {
    expect(
      adminRatePreviewResponseSchema.safeParse({
        ...preview,
        counts: { ...preview.counts, [kind]: 0 },
      }).success,
    ).toBe(false);
  }
});

it('portal passwords are returned exactly when generated', () => {
  const account = {
    id,
    email: 'user@example.com',
    status: 'active',
    lastLoginAt: null,
    createdAt: '2026-10-14T10:00:00Z',
  };
  const generated = {
    auditId: id,
    account,
    passwordSource: 'generated',
    temporaryPassword: 'Temp1234!',
  };
  const supplied = { auditId: id, account, passwordSource: 'supplied' };
  expect(adminPortalAccountCreateResponseSchema.parse(generated)).toEqual(
    generated,
  );
  expect(adminPortalAccountCreateResponseSchema.parse(supplied)).toEqual(
    supplied,
  );
  expect(
    adminPortalAccountCreateResponseSchema.safeParse({
      ...generated,
      temporaryPassword: undefined,
    }).success,
  ).toBe(false);
  expect(
    adminPortalAccountCreateResponseSchema.safeParse({
      ...supplied,
      temporaryPassword: 'Temp1234!',
    }).success,
  ).toBe(false);
});

it('portal ledger projection removes credit notes and admin actor data', () => {
  const entry = {
    id,
    kind: 'credit_recharge',
    amount: '500.00',
    balanceAfter: '500.00',
    note: 'internal contract terms',
    noteVisibility: 'admin',
    paymentStatus: 'pending',
    actor: { id, name: '管理员' },
    occurredAt: '2026-10-14T10:00:00Z',
  };
  const parsed = adminLedgerEntrySchema.parse(entry);
  const projected = {
    id,
    kind: 'recharge',
    amount: '500.00',
    balanceAfter: '500.00',
    occurredAt: '2026-10-14T10:00:00Z',
    note: '',
  };
  expect(projectPortalLedgerEntry(parsed)).toEqual(projected);
  expect(portalLedgerEntrySchema.parse(projected)).toEqual(projected);
  expect(portalLedgerEntrySchema.safeParse(entry).success).toBe(false);
  expect(
    portalLedgerEntrySchema.safeParse({
      ...projected,
      internalNote: entry.note,
    }).success,
  ).toBe(false);
  expect(
    adminLedgerEntrySchema.safeParse({ ...entry, noteVisibility: 'customer' })
      .success,
  ).toBe(false);
  const recharge = adminLedgerEntrySchema.parse({
    ...entry,
    kind: 'recharge',
    noteVisibility: 'customer',
    note: '充值',
  });
  expect(projectPortalLedgerEntry(recharge)).toEqual({
    ...projected,
    kind: 'recharge',
    note: '充值',
  });
});

it('customer operations and portal projections do not reference admin schemas', () => {
  const forbidden = new Set<unknown>(
    Object.entries(adminSchemas)
      .filter(
        ([name, value]) =>
          name.startsWith('admin') && value instanceof z.ZodType,
      )
      .map(([, value]) => value),
  );
  const visited = new WeakSet<object>();
  function inspect(value: unknown): void {
    expect(forbidden.has(value)).toBe(false);
    if (typeof value !== 'object' || value === null || visited.has(value))
      return;
    visited.add(value);
    for (const child of Object.values(value)) inspect(child);
  }
  const operations = Object.values(apiContract).filter(
    (op) => op.access === 'customer',
  );
  expect(operations.length).toBeGreaterThan(0);
  for (const op of operations) {
    inspect(op.request);
    inspect(op.responses);
  }
  inspect(portalLedgerEntrySchema);
});

it('export requires POST and returns an audit ID', () => {
  expect(adminApiContract.adminRateExport.method).toBe('POST');
  const response = {
    auditId: id,
    filename: 'rates.csv',
    encoding: 'UTF-8',
    contentType: 'text/csv',
    csv: 'prefix,country,rate\n',
  };
  expect(
    adminApiContract.adminRateExport.responses[200].parse(response),
  ).toEqual(response);
  expect(
    adminApiContract.adminRateExport.responses[200].safeParse({
      ...response,
      auditId: undefined,
    }).success,
  ).toBe(false);
  expect(
    adminApiContract.adminRateExport.responses[200].safeParse({
      ...response,
      auditId: null,
    }).success,
  ).toBe(false);
});

it('no-op mutations may return a null audit id and real writes require one', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  expect(adminMutationResponseSchema.parse({ auditId: null })).toEqual({
    auditId: null,
  });
  expect(adminMutationResponseSchema.parse({ auditId: id })).toEqual({
    auditId: id,
  });
  expect(adminMutationResponseSchema.safeParse({}).success).toBe(false);
  expect(adminAuditedMutationResponseSchema.parse({ auditId: id })).toEqual({
    auditId: id,
  });
  expect(
    adminAuditedMutationResponseSchema.safeParse({ auditId: null }).success,
  ).toBe(false);
  expect(adminAuditedMutationResponseSchema.safeParse({}).success).toBe(false);
  for (const key of [
    'adminTenantEdit',
    'adminTenantDisable',
    'adminTenantEnable',
    'adminTenantSettings',
    'adminPortalAccountDisable',
    'adminPortalAccountEnable',
    'adminAccountEnable',
    'adminAccountDisable',
  ] as const) {
    expect(adminApiContract[key].responses[200]).toBe(
      adminMutationResponseSchema,
    );
  }
  const stamp = '2026-10-14T10:00:00Z';
  const account = {
    id,
    name: '管理员',
    email: 'admin@example.com',
    status: 'active',
    lastLoginAt: null,
    createdAt: stamp,
  };
  const portalAccount = {
    id,
    email: 'user@example.com',
    status: 'active',
    lastLoginAt: null,
    createdAt: stamp,
  };
  const tenant = {
    id,
    code: 'ABC001',
    name: '客户',
    currency: 'CNY',
    status: 'active',
    health: 'normal',
    settingsConfigured: true,
    balance: '0',
    overdraftLimit: '100',
    availableBalance: '100',
    monthConsumption: '0',
    pendingReceivable: '0',
    contactName: '',
    contactPhone: '',
    remark: '',
    settings: {
      overdraftLimit: '100',
      lowBalanceThreshold: '0',
      emails: ['admin@example.com'],
    },
    createdAt: stamp,
  };
  const version = { id, effectiveFrom: stamp, entries: [] };
  const entry = {
    id,
    kind: 'recharge',
    amount: '10',
    balanceAfter: '10',
    note: '',
    noteVisibility: 'customer',
    paymentStatus: null,
    actor: null,
    occurredAt: stamp,
  };
  const writes: [keyof typeof adminApiContract, Record<string, unknown>][] = [
    [
      'adminTenantCreate',
      {
        auditId: id,
        tenant,
        initialRateVersionId: id,
        effectiveFrom: stamp,
      },
    ],
    [
      'adminAccountCreate',
      { auditId: id, account, temporaryPassword: 'Temp1234!' },
    ],
    [
      'adminPortalAccountCreate',
      {
        auditId: id,
        account: portalAccount,
        passwordSource: 'generated',
        temporaryPassword: 'Temp1234!',
      },
    ],
    [
      'adminPortalAccountCreate',
      { auditId: id, account: portalAccount, passwordSource: 'supplied' },
    ],
    [
      'adminBalanceOperation',
      { auditId: id, currency: 'CNY', entry, balance: '10' },
    ],
    ['adminRateCancelFutureVersion', { auditId: id, cancelledVersionId: id }],
    ['adminRateEdit', { auditId: id, version }],
    ['adminRateImportCommit', { auditId: id, version }],
    ['adminRateCopyCommit', { auditId: id, version }],
    [
      'adminRateExport',
      {
        auditId: id,
        filename: 'rates.csv',
        encoding: 'UTF-8',
        contentType: 'text/csv',
        csv: 'prefix,country,rate\n',
      },
    ],
    [
      'adminConfirmPayment',
      {
        auditId: id,
        settlementId: id,
        ledgerEntryId: id,
        receivedOn: '2026-10-14',
      },
    ],
    ['adminVoidReceivable', { auditId: id, ledgerEntryId: id, voidId: id }],
    [
      'adminReversePayment',
      {
        auditId: id,
        ledgerEntryId: id,
        settlementId: id,
        reversalId: id,
      },
    ],
  ];
  for (const [key, response] of writes) {
    const schema = adminApiContract[key].responses[200];
    expect(schema.parse(response)).toEqual(response);
    expect(schema.safeParse({ ...response, auditId: null }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...response, auditId: undefined }).success).toBe(
      false,
    );
  }
});

it('reset operations reuse the live definitions and error maps are per operation', () => {
  expect(adminApiContract.resetAdminPassword).toBe(
    apiContract.resetAdminPassword,
  );
  expect(adminApiContract.resetPortalAccountPassword).toBe(
    apiContract.resetPortalAccountPassword,
  );
  expect('409' in adminApiContract.adminTenants.responses).toBe(false);
  expect('413' in adminApiContract.adminTenants.responses).toBe(false);
  const error = (code: string) => ({
    error: { code, message: '冲突', requestId: id },
  });
  expect(
    adminApiContract.adminTenants.responses[400].safeParse(error('CSV_INVALID'))
      .success,
  ).toBe(false);
  expect(
    adminApiContract.adminAccountCreate.responses[409].safeParse(
      error('EMAIL_EXISTS'),
    ).success,
  ).toBe(true);
  expect(
    adminApiContract.adminAccountCreate.responses[409].safeParse(
      error('ALREADY_RECEIVED'),
    ).success,
  ).toBe(false);
  for (const code of ['PREVIEW_STALE', 'RATE_VERSION_CONFLICT']) {
    expect(
      adminApiContract.adminRateImportCommit.responses[409].safeParse(
        error(code),
      ).success,
    ).toBe(true);
  }
});

it('minutes accept fractional duration independently of money and payments reject future dates', () => {
  const overview = {
    currency: 'CNY',
    asOf: '2026-09-30T15:59:59Z',
    monthSpend: '0',
    monthCallMinutes: '000.123456',
    answeredCalls: 0,
    unansweredCalls: 0,
    dailyTotal: '0',
    daily: Array.from({ length: 30 }, (_, index) => ({
      date: `2026-09-${String(index + 1).padStart(2, '0')}`,
      spend: '0',
    })),
  };
  expect(adminTenantOverviewResponseSchema.parse(overview)).toEqual(overview);
  expect(
    adminTenantOverviewResponseSchema.safeParse({
      ...overview,
      monthCallMinutes: '-1',
    }).success,
  ).toBe(false);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  expect(
    adminConfirmPaymentRequestSchema.parse({
      receivedOn: '2026-10-14',
      expectedLatestSettlementId: null,
    }),
  ).toEqual({
    receivedOn: '2026-10-14',
    expectedLatestSettlementId: null,
    note: '',
  });
  expect(
    adminConfirmPaymentRequestSchema.safeParse({
      receivedOn: '2026-10-15',
      expectedLatestSettlementId: null,
    }).success,
  ).toBe(false);
});

it.each([
  ['balance_topup', { ledgerEntryId: id, amount: '10', currency: 'CNY' }],
  [
    'balance_credit_topup',
    { ledgerEntryId: id, amount: '10', currency: 'USD' },
  ],
  ['balance_gift', { ledgerEntryId: id, amount: '10', currency: 'CNY' }],
  [
    'receivable_confirm',
    {
      ledgerEntryId: id,
      settlementId: id,
      amount: '10',
      currency: 'USD',
      receivedOn: '2026-10-14',
    },
  ],
  ['rate_entry_edit', { rateVersionId: id }],
  ['rate_import', { rateVersionId: id }],
  ['rate_export', { rateVersionId: id }],
  ['rate_copy', { rateVersionId: id, sourceTenantId: id, sourceVersionId: id }],
  ['tenant_create', { code: 'ABC001', currency: 'CNY', rateVersionId: id }],
  ['admin_create', { email: 'admin@example.com' }],
  ['portal_account_create', { email: 'user@example.com' }],
])('audit action %s requires its specific content', (action, fields) => {
  const payload = {
    id,
    action,
    actor: { id, name: '管理员' },
    occurredAt: '2026-10-14T10:00:00Z',
    tenantId: id,
    target: { kind: 'tenant', id },
    content: { summary: '操作', changes: [], ...fields },
  };
  expect(auditPayloadSchema.parse(payload)).toEqual(payload);
  for (const field of Object.keys(fields)) {
    expect(
      auditPayloadSchema.safeParse({
        ...payload,
        content: { ...payload.content, [field]: undefined },
      }).success,
    ).toBe(false);
  }
});

it('standalone audit content preserves action-specific fields', () => {
  const event = auditContentSchema.parse({
    action: 'balance_adjustment',
    content: {
      summary: '冲正',
      changes: [],
      ledgerEntryId: id,
      reason: '重复充值',
      amount: '-10',
      currency: 'CNY',
    },
  });
  if (event.action !== 'balance_adjustment') throw new Error('Wrong action');
  expect(event.content.reason).toBe('重复充值');
  for (const content of [
    { ...event.content, reason: '   ' },
    { ...event.content, amount: '0' },
    { ...event.content, currency: 'EUR' },
    { ...event.content, ledgerEntryId: undefined },
  ]) {
    expect(
      auditContentSchema.safeParse({ action: event.action, content }).success,
    ).toBe(false);
  }
  expect(
    auditPayloadSchema.options.map((option) => option.shape.action.value),
  ).toEqual(auditActionSchema.options);
});

it('received receivables retain settlement notes and cannot be overdue', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T10:00:00Z'));
  const receivable = {
    ledgerEntryId: id,
    latestSettlementId: id,
    tenant: { id, code: 'ABC001', name: '客户', currency: 'CNY' },
    amount: '500',
    internalNote: '合同账期',
    createdAt: '2026-10-01T10:00:00Z',
    actor: { id, name: '管理员' },
    ageDays: 31,
    overdue: false,
    payment: {
      status: 'received',
      settlementId: id,
      receivedOn: '2026-10-14',
      note: '银行转账',
      confirmedBy: id,
    },
  };
  expect(adminReceivableSchema.parse(receivable)).toEqual(receivable);
  expect(
    adminReceivableSchema.safeParse({
      ...receivable,
      payment: { ...receivable.payment, note: undefined },
    }).success,
  ).toBe(false);
  expect(
    adminReceivableSchema.safeParse({ ...receivable, overdue: true }).success,
  ).toBe(false);
});

it('payment dates use Beijing today at the UTC midnight boundary', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T15:59:59Z'));
  expect(
    adminConfirmPaymentRequestSchema.safeParse({
      receivedOn: '2026-10-15',
      expectedLatestSettlementId: null,
    }).success,
  ).toBe(false);
  vi.setSystemTime(new Date('2026-10-14T16:00:00Z'));
  expect(
    adminConfirmPaymentRequestSchema.parse({
      receivedOn: '2026-10-15',
      expectedLatestSettlementId: null,
    }),
  ).toEqual({
    receivedOn: '2026-10-15',
    expectedLatestSettlementId: null,
    note: '',
  });
});
it('received receivables retain settlement notes and cannot predate the credit', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
  const entry = {
    ledgerEntryId: id,
    latestSettlementId: id,
    tenant: { id, code: 'ABC001', name: '客户', currency: 'CNY' },
    amount: '500.00',
    internalNote: '账期',
    createdAt: '2026-10-14T16:00:00Z',
    actor: { id, name: '管理员' },
    ageDays: 1,
    overdue: false,
    payment: {
      status: 'received',
      settlementId: id,
      receivedOn: '2026-10-15',
      confirmedBy: id,
      note: '银行转账',
    },
  };
  expect(adminReceivableSchema.parse(entry)).toEqual(entry);
  expect(
    adminReceivableSchema.safeParse({
      ...entry,
      payment: { ...entry.payment, note: undefined },
    }).success,
  ).toBe(false);
  expect(
    adminReceivableSchema.safeParse({
      ...entry,
      payment: { ...entry.payment, receivedOn: '2026-10-14' },
    }).success,
  ).toBe(false);
});

describe('final Phase 5 decisions', () => {
  it.each(['topup', 'credit_topup', 'gift'])(
    '%s accepts two decimals and ten integer digits only',
    (kind) => {
      const input = { kind, currency: 'CNY', idempotencyKey: 'manual:limits' };
      for (const amount of ['0.01', '9999999999.99']) {
        expect(
          adminBalanceOperationRequestSchema.parse({ ...input, amount }).amount,
        ).toBe(amount);
      }
      for (const amount of ['1.001', '1.000', '10000000000', '0', '-0.01']) {
        expect(
          adminBalanceOperationRequestSchema.safeParse({ ...input, amount })
            .success,
        ).toBe(false);
      }
    },
  );
  it('adjustments accept four decimals and cap both signs without rounding', () => {
    for (const amount of [
      '0.0001',
      '-0.1350',
      '9999999999.9999',
      '-9999999999.9999',
    ]) {
      expect(
        adminBalanceOperationRequestSchema.parse({
          ...balanceInput,
          amount,
          reason: '冲正',
        }).amount,
      ).toBe(amount);
    }
    for (const amount of [
      '0.00001',
      '-0.00001',
      '10000000000',
      '-10000000000',
    ]) {
      expect(
        adminBalanceOperationRequestSchema.safeParse({
          ...balanceInput,
          amount,
          reason: '冲正',
        }).success,
      ).toBe(false);
    }
    const configured = createAdminInputAmountSchemas(3);
    expect(configured.positive.parse('999.99')).toBe('999.99');
    expect(configured.positive.safeParse('1000').success).toBe(false);
    expect(configured.adjustment.safeParse('-1000').success).toBe(false);
    expect(configured.settings.safeParse('1000').success).toBe(false);
  });
  it('settings require nonnegative two-decimal capped values', () => {
    const settings = {
      overdraftLimit: '0',
      lowBalanceThreshold: '9999999999.99',
      emails: [],
    };
    expect(adminTenantSettingsRequestSchema.parse(settings)).toEqual(settings);
    for (const field of ['overdraftLimit', 'lowBalanceThreshold']) {
      for (const value of ['-0.01', '1.001', '10000000000']) {
        expect(
          adminTenantSettingsRequestSchema.safeParse({
            ...settings,
            [field]: value,
          }).success,
        ).toBe(false);
      }
    }
  });
  it('recipients lowercase and deduplicate before the twenty-address cap', () => {
    const settings = { overdraftLimit: '100', lowBalanceThreshold: '200' };
    expect(
      adminTenantSettingsRequestSchema.parse({
        ...settings,
        emails: Array.from({ length: 30 }, (_, i) =>
          i % 2 ? 'ADMIN@example.com' : 'admin@example.com',
        ),
      }).emails,
    ).toEqual(['admin@example.com']);
    const emails = Array.from({ length: 20 }, (_, i) => `user${i}@example.com`);
    expect(
      adminTenantSettingsRequestSchema.parse({
        ...settings,
        emails: [...emails, 'USER0@example.com'],
      }).emails,
    ).toEqual(emails);
    expect(
      adminTenantSettingsRequestSchema.safeParse({
        ...settings,
        emails: [...emails, 'extra@example.com'],
      }).success,
    ).toBe(false);
    expect(
      adminTenantSettingsRequestSchema.safeParse({
        ...settings,
        emails: ['bad'],
      }).success,
    ).toBe(false);
    expect(
      adminTenantSettingsRequestSchema.parse({
        ...settings,
        emails: Array(100).fill('admin@example.com'),
      }).emails,
    ).toEqual(['admin@example.com']);
    expect(
      adminTenantSettingsRequestSchema.safeParse({
        ...settings,
        emails: Array(101).fill('admin@example.com'),
      }).success,
    ).toBe(false);
  });
  it('saved settings preserve historical precision, amounts and recipients', () => {
    const settings = {
      overdraftLimit: '123456789012.3456',
      lowBalanceThreshold: '-1.23456',
      emails: Array.from({ length: 21 }, (_, i) => `USER${i}@example.com`),
    };
    expect(adminTenantSettingsResponseSchema.parse(settings)).toEqual(settings);
    expect(
      adminSchemas.adminTenantDetailResponseSchema.shape.settings.parse(
        settings,
      ),
    ).toEqual(settings);
    expect(
      adminSchemas.adminTenantCreateResponseSchema.shape.tenant.shape.settings.parse(
        settings,
      ),
    ).toEqual(settings);
    expect(adminTenantSettingsRequestSchema.safeParse(settings).success).toBe(
      false,
    );
  });
  it('raised row limits remain readable and cancellable with a complete audit', () => {
    const entries = Array.from(
      { length: DEFAULT_ADMIN_RATE_MAX_ROWS + 1 },
      (_, i) => ({ prefix: String(i + 1), country: '测试', rate: '0.01' }),
    );
    expect(createAdminRateEntriesSchema(entries.length).parse(entries)).toEqual(
      entries,
    );
    const version = { id, effectiveFrom: '2026-10-15T00:00:00Z', entries };
    expect(
      adminRateVersionResponseSchema.parse({ auditId: id, version }),
    ).toEqual({ auditId: id, version });
    expect(
      adminSchemas.adminRatesResponseSchema.parse({
        currency: 'CNY',
        current: version,
        scheduled: [version],
      }),
    ).toEqual({ currency: 'CNY', current: version, scheduled: [version] });
    const content = {
      summary: '取消排期',
      changes: [],
      cancelledVersionId: id,
      entries,
    };
    expect(
      auditContentSchema.parse({ action: 'rate_schedule_cancel', content }),
    ).toEqual({ action: 'rate_schedule_cancel', content });
  });
  it('tenant codes normalize uppercase at creation', () => {
    expect(
      adminTenantCreateRequestSchema.parse({
        code: 'abc001',
        name: '客户',
        currency: 'CNY',
        settings: {
          lowBalanceThreshold: '200',
          emails: ['ADMIN@example.com', 'admin@example.com'],
        },
        initialRates: { kind: 'blank' },
      }),
    ).toMatchObject({
      code: 'ABC001',
      settings: { emails: ['admin@example.com'] },
    });
  });
  it('CSV byte limits reject the extra byte hidden by base64 padding', () => {
    const file = (bytes: number) => ({
      filename: 'rates.csv',
      contentBase64: Buffer.alloc(bytes).toString('base64'),
    });
    expect(adminCsvFileSchema.parse(file(DEFAULT_ADMIN_CSV_MAX_BYTES))).toEqual(
      file(DEFAULT_ADMIN_CSV_MAX_BYTES),
    );
    expect(
      adminCsvFileSchema.safeParse(file(DEFAULT_ADMIN_CSV_MAX_BYTES + 1))
        .success,
    ).toBe(false);
    const configured = createAdminCsvFileSchema(2);
    expect(configured.parse(file(2))).toEqual(file(2));
    expect(configured.safeParse(file(3)).success).toBe(false);
  });
  it('rate row caps are named defaults and configurable', () => {
    const entries = Array.from(
      { length: DEFAULT_ADMIN_RATE_MAX_ROWS },
      (_, i) => ({ prefix: String(i + 1), country: '测试', rate: '0.01' }),
    );
    expect(adminRateEntriesSchema.parse(entries)).toEqual(entries);
    expect(
      adminRateEntriesSchema.safeParse([
        ...entries,
        { prefix: '99999', country: '测试', rate: '0.01' },
      ]).success,
    ).toBe(false);
    const configured = createAdminRateEntriesSchema(1);
    expect(configured.parse(entries.slice(0, 1))).toEqual(entries.slice(0, 1));
    expect(configured.safeParse(entries.slice(0, 2)).success).toBe(false);
    expect(DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS).toBe(3600000);
  });
  it('cancellation contract requires a version and a complete audit snapshot', () => {
    const op = adminApiContract.adminRateCancelFutureVersion;
    expect(op.path).toBe(
      '/api/admin/tenants/{tenantId}/rates/cancel-future-version',
    );
    expect(op.method).toBe('POST');
    expect(op.request.params.parse({ tenantId: id })).toEqual({ tenantId: id });
    expect(op.request.body.parse({ versionId: id })).toEqual({ versionId: id });
    expect(op.request.body.safeParse({}).success).toBe(false);
    expect(
      op.responses[200].parse({ auditId: id, cancelledVersionId: id }),
    ).toEqual({ auditId: id, cancelledVersionId: id });
    expect(
      op.responses[409].parse({
        error: {
          code: 'RATE_VERSION_CONFLICT',
          message: '已生效',
          requestId: 'request',
        },
      }).error.code,
    ).toBe('RATE_VERSION_CONFLICT');
    const content = {
      summary: '取消排期',
      changes: [],
      cancelledVersionId: id,
      entries: [{ prefix: '86', country: '中国', rate: '0.01' }],
    };
    expect(
      auditContentSchema.parse({ action: 'rate_schedule_cancel', content }),
    ).toEqual({ action: 'rate_schedule_cancel', content });
    for (const field of ['cancelledVersionId', 'entries']) {
      expect(
        auditContentSchema.safeParse({
          action: 'rate_schedule_cancel',
          content: { ...content, [field]: undefined },
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    [
      'adminAccountEnable',
      '/api/admin/admins/{id}/enable',
      'admin_enable',
      'admin',
    ],
    [
      'adminPortalAccountDisable',
      '/api/admin/portal-accounts/{id}/disable',
      'portal_account_disable',
      'portal_account',
    ],
    [
      'adminPortalAccountEnable',
      '/api/admin/portal-accounts/{id}/enable',
      'portal_account_enable',
      'portal_account',
    ],
  ] as const)(
    '%s exposes an admin-only POST and audit action',
    (key, path, action, kind) => {
      const op = adminApiContract[key];
      expect(op.path).toBe(path);
      expect(op.method).toBe('POST');
      expect(op.access).toBe('admin');
      expect(op.request.params.parse({ id })).toEqual({ id });
      expect(op.request.body.parse(undefined)).toBeUndefined();
      expect(op.responses[200].parse({ auditId: id })).toEqual({ auditId: id });
      const payload = {
        id,
        action,
        actor: { id, name: '管理员' },
        occurredAt: '2026-10-14T10:00:00Z',
        tenantId: kind === 'admin' ? null : id,
        target: { kind, id },
        content: {
          summary: '账号状态变更',
          changes: [{ field: 'status', before: 'disabled', after: 'active' }],
        },
      };
      expect(auditPayloadSchema.parse(payload)).toEqual(payload);
    },
  );
});
