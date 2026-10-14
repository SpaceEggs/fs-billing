import { afterEach, expect, it, vi } from 'vitest';
import {
  adminApiContract,
  adminBalanceOperationRequestSchema,
  adminLedgerEntrySchema,
  adminReceivableSchema,
  adminReceivablesQuerySchema,
  adminRateScheduleSchema,
  adminRateVersionSchema,
  auditContentSchema,
  createAdminRateScheduleSchema,
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  DEFAULT_ADMIN_TEMPORARY_PASSWORD_TTL_MS,
  DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS,
} from './index.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const otherId = '550e8400-e29b-41d4-a716-446655440001';
const now = Date.parse('2026-10-14T10:00:23.456Z');
afterEach(() => vi.useRealTimers());

it('schedule horizon accepts any ISO instant within inclusive configurable bounds', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const scheduled = (time: number) => ({
    kind: 'scheduled',
    effectiveFrom: new Date(time).toISOString(),
  });
  expect(DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS).toBe(31536000000);
  for (const time of [now, now + 1, now + 31536000000]) {
    expect(adminRateScheduleSchema.parse(scheduled(time))).toEqual(
      scheduled(time),
    );
  }
  for (const time of [now - 1, now + 31536000001]) {
    expect(adminRateScheduleSchema.safeParse(scheduled(time)).success).toBe(
      false,
    );
  }
  const offset = {
    kind: 'scheduled',
    effectiveFrom: '2026-10-14T18:00:23.456+08:00',
  };
  expect(adminRateScheduleSchema.parse(offset)).toEqual(offset);
  const configured = createAdminRateScheduleSchema(1000);
  expect(configured.parse(scheduled(now + 1000))).toEqual(
    scheduled(now + 1000),
  );
  expect(configured.safeParse(scheduled(now + 1001)).success).toBe(false);
  vi.setSystemTime(now + 1001);
  expect(configured.safeParse(scheduled(now + 1000)).success).toBe(false);
  expect(configured.parse({ kind: 'immediate' })).toEqual({
    kind: 'immediate',
  });
  for (const limit of [0, -1, 0.5, Infinity, NaN]) {
    expect(() => createAdminRateScheduleSchema(limit)).toThrow();
  }
  expect(
    adminRateVersionSchema.parse({
      id,
      effectiveFrom: '2030-01-01T00:00:00Z',
      entries: [],
    }),
  ).toEqual({
    id,
    effectiveFrom: '2030-01-01T00:00:00Z',
    entries: [],
  });
});

it('void and reverse payment expose admin POSTs with required reasons and event IDs', () => {
  const cases = [
    {
      op: adminApiContract.adminVoidReceivable,
      path: '/api/admin/receivables/{id}/void',
      body: { adjustmentLedgerEntryId: otherId, reason: ' 错误赊账 ' },
      response: { auditId: id, ledgerEntryId: id, voidId: otherId },
      conflict: 'RECEIVABLE_REVERSAL_MISMATCH',
    },
    {
      op: adminApiContract.adminReversePayment,
      path: '/api/admin/receivables/{id}/reverse-payment',
      body: { settlementId: otherId, reason: ' 错误收款确认 ' },
      response: {
        auditId: id,
        ledgerEntryId: id,
        settlementId: otherId,
        reversalId: id,
      },
      conflict: 'SETTLEMENT_CONFLICT',
    },
  ];
  for (const { op, path, body, response, conflict } of cases) {
    expect(op.path).toBe(path);
    expect(op.method).toBe('POST');
    expect(op.access).toBe('admin');
    expect(op.request.params.parse({ id })).toEqual({ id });
    expect(op.request.body.parse(body)).toEqual({
      ...body,
      reason: body.reason.trim(),
    });
    for (const field of Object.keys(body)) {
      expect(
        op.request.body.safeParse({ ...body, [field]: undefined }).success,
      ).toBe(false);
    }
    expect(op.request.body.safeParse({ ...body, reason: '   ' }).success).toBe(
      false,
    );
    expect(op.request.body.safeParse({ ...body, actor: id }).success).toBe(
      false,
    );
    expect(op.responses[200].parse(response)).toEqual(response);
    expect(
      op.responses[200].safeParse({ ...response, auditId: undefined }).success,
    ).toBe(false);
    expect(
      op.responses[409].parse({
        error: { code: conflict, message: '冲突', requestId: id },
      }).error.code,
    ).toBe(conflict);
    expect(
      op.responses[409].safeParse({
        error: { code: 'EMAIL_EXISTS', message: '冲突', requestId: id },
      }).success,
    ).toBe(false);
  }
  expect(
    adminApiContract.adminConfirmPayment.responses[409].parse({
      error: { code: 'ALREADY_RECEIVED', message: '已收', requestId: id },
    }).error.code,
  ).toBe('ALREADY_RECEIVED');
});

it('receivable states retain settlement or void details and only pending can be overdue', () => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const entry = {
    ledgerEntryId: id,
    tenant: { id, code: 'ABC001', name: '客户', currency: 'CNY' },
    amount: '500',
    internalNote: '内部',
    createdAt: '2026-09-01T00:00:00Z',
    actor: { id, name: '管理员' },
    ageDays: 43,
    overdue: false,
  };
  const payments = [
    {
      status: 'received',
      settlementId: otherId,
      receivedOn: '2026-10-14',
      note: '到账',
      confirmedBy: id,
    },
    {
      status: 'voided',
      voidId: id,
      adjustmentLedgerEntryId: otherId,
      reason: '冲正',
      voidedBy: id,
      voidedAt: '2026-10-14T10:00:23.456Z',
    },
  ];
  for (const payment of payments) {
    expect(adminReceivableSchema.parse({ ...entry, payment })).toEqual({
      ...entry,
      payment,
    });
    expect(
      adminReceivableSchema.safeParse({ ...entry, payment, overdue: true })
        .success,
    ).toBe(false);
    for (const field of Object.keys(payment)) {
      expect(
        adminReceivableSchema.safeParse({
          ...entry,
          payment: { ...payment, [field]: undefined },
        }).success,
      ).toBe(false);
    }
  }
  expect(
    adminReceivableSchema.parse({
      ...entry,
      payment: { status: 'pending' },
      overdue: true,
    }).payment,
  ).toEqual({ status: 'pending' });
  expect(adminReceivablesQuerySchema.parse({ status: 'voided' }).status).toBe(
    'voided',
  );
  expect(
    adminLedgerEntrySchema.parse({
      id,
      kind: 'credit_recharge',
      amount: '500',
      balanceAfter: '0',
      note: '',
      noteVisibility: 'admin',
      paymentStatus: 'voided',
      actor: null,
      occurredAt: '2026-10-14T10:00:23.456Z',
    }).paymentStatus,
  ).toBe('voided');
});

it.each([
  ['receivable_void', { voidId: id, adjustmentLedgerEntryId: otherId }],
  ['receivable_payment_reverse', { settlementId: otherId, reversalId: id }],
])('audit %s requires reason and affected event IDs', (action, fields) => {
  const content = {
    summary: '修正应收',
    changes: [],
    ledgerEntryId: id,
    amount: '500',
    currency: 'CNY',
    reason: '错误操作',
    ...fields,
  };
  expect(auditContentSchema.parse({ action, content })).toEqual({
    action,
    content,
  });
  for (const field of Object.keys(content)) {
    expect(
      auditContentSchema.safeParse({
        action,
        content: { ...content, [field]: undefined },
      }).success,
    ).toBe(false);
  }
  expect(
    auditContentSchema.safeParse({
      action,
      content: { ...content, reason: '  ' },
    }).success,
  ).toBe(false);
});

it('large gift and credit requests require no confirmation token', () => {
  for (const kind of ['gift', 'credit_topup']) {
    for (const [currency, amount] of [
      ['CNY', '10000.01'],
      ['USD', '1500.01'],
    ]) {
      const input = { kind, currency, amount, idempotencyKey: 'manual:large' };
      expect(adminBalanceOperationRequestSchema.parse(input)).toMatchObject(
        input,
      );
      expect(
        adminBalanceOperationRequestSchema.safeParse({
          ...input,
          confirmToken: 'token',
        }).success,
      ).toBe(false);
    }
  }
});

it('later auth and cancellation services have the decided configuration defaults', () => {
  expect(DEFAULT_ADMIN_TEMPORARY_PASSWORD_TTL_MS).toBe(259200000);
  expect(DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS).toBe(60);
});
