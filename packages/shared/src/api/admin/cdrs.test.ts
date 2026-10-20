import { describe, expect, it } from 'vitest';
import { mergedChargeRowSchema } from '../ledger-merge.js';
import { portalCdrSchema, portalLedgerRowSchema } from '../portal/index.js';
import {
  adminApiContract,
  adminCdrApiContract,
  adminCdrCountriesQuerySchema,
  adminCdrExportRequestSchema,
  adminCdrSchema,
  adminCdrsQuerySchema,
  adminCdrsResponseSchema,
  adminLedgerQuerySchema,
  adminLedgerResponseSchema,
  adminLedgerRowSchema,
  auditPayloadSchema,
} from './index.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const answered = {
  iso: null,
  description: null,
  callUuid: id,
  startedAt: '2026-09-27T03:09:40.000Z',
  answeredAt: '2026-09-27T03:10:05.000Z',
  endedAt: '2026-09-27T03:16:33.000Z',
  caller: '075586001234',
  callee: '18765551234',
  country: '牙买加',
  matchedPrefix: '1876',
  durationSeconds: 388,
  billedMinutes: '7',
  rate: '0.25',
  charge: '1.75',
  hangupCause: 'NORMAL_CLEARING',
  unverified: true,
};
const range = { from: '2026-09-27', to: '2026-09-27' };

describe('admin CDR rows', () => {
  it('carry the unverified flag and nothing else extra', () => {
    expect(adminCdrSchema.parse(answered)).toEqual(answered);
    expect(
      adminCdrSchema.safeParse({ ...answered, unverified: undefined }).success,
    ).toBe(false);
    expect(
      adminCdrSchema.safeParse({ ...answered, billing_unverified: true })
        .success,
    ).toBe(false);
  });
});

describe('portal schemas against admin rows', () => {
  it('refuse an admin CDR row because of its unverified flag', () => {
    const row = adminCdrSchema.parse(answered);
    expect(row.unverified).toBe(true);
    expect(portalCdrSchema.safeParse(row).success).toBe(false);
  });

  it('refuse an admin ledger row because of its actor and payment fields', () => {
    const row = adminLedgerRowSchema.parse({
      id,
      kind: 'recharge',
      amount: '500.00',
      balanceAfter: '500.00',
      occurredAt: '2026-09-23T02:15:36.000Z',
      note: '银行转账',
      noteVisibility: 'customer',
      paymentStatus: null,
      actor: { id, name: '管理员' },
    });
    expect(portalLedgerRowSchema.safeParse(row).success).toBe(false);
  });
});

describe('admin CDR list contract', () => {
  it('parses the unverified filter from a query string, not from truthiness', () => {
    expect(adminCdrsQuerySchema.parse(range).unverifiedOnly).toBe(false);
    expect(
      adminCdrsQuerySchema.parse({ ...range, unverifiedOnly: 'true' })
        .unverifiedOnly,
    ).toBe(true);
    expect(
      adminCdrsQuerySchema.parse({ ...range, unverifiedOnly: 'false' })
        .unverifiedOnly,
    ).toBe(false);
    expect(
      adminCdrsQuerySchema.safeParse({ ...range, unverifiedOnly: 'yes' })
        .success,
    ).toBe(false);
  });

  it('caps the range at one month like the portal', () => {
    expect(
      adminCdrsQuerySchema.safeParse({ from: '2026-09-01', to: '2026-10-01' })
        .success,
    ).toBe(false);
    expect(
      adminCdrExportRequestSchema.safeParse({
        from: '2026-09-01',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
    expect(
      adminCdrCountriesQuerySchema.safeParse({
        from: '2026-09-01',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
  });

  it('takes the unverified filter in the export body as a boolean', () => {
    expect(adminCdrExportRequestSchema.parse(range)).toEqual({
      ...range,
      status: 'answered',
      unverifiedOnly: false,
    });
    expect(
      adminCdrExportRequestSchema.parse({ ...range, unverifiedOnly: true })
        .unverifiedOnly,
    ).toBe(true);
    expect(
      adminCdrExportRequestSchema.safeParse({
        ...range,
        unverifiedOnly: 'true',
      }).success,
    ).toBe(false);
  });

  it('counts unverified calls inside the filtered total', () => {
    const response = {
      currency: 'CNY',
      items: [answered],
      pagination: { page: 1, pageSize: 50, total: 286 },
      summary: {
        billedMinutes: '1160',
        charge: '58',
        unansweredCalls: 15,
        unverifiedCalls: 4,
      },
    };
    expect(adminCdrsResponseSchema.parse(response)).toEqual(response);
    expect(
      adminCdrsResponseSchema.safeParse({
        ...response,
        summary: { ...response.summary, unverifiedCalls: 287 },
      }).success,
    ).toBe(false);
  });
});

describe('admin merged ledger', () => {
  const base = {
    id,
    amount: '500.00',
    balanceAfter: '500.00',
    occurredAt: '2026-09-23T02:15:36.000Z',
    actor: { id, name: '管理员' },
  };
  const credit = {
    ...base,
    kind: 'credit_recharge',
    note: '合同账期',
    noteVisibility: 'admin',
    paymentStatus: 'pending',
  };
  const recharge = {
    ...base,
    kind: 'recharge',
    note: '银行转账',
    noteVisibility: 'customer',
    paymentStatus: null,
  };
  const charge = {
    kind: 'call_charge',
    day: '2026-09-29',
    calls: 1702,
    amount: '-88.64',
    balanceAfter: '-35.2',
    occurredAt: '2026-09-29T06:03:22.000Z',
    partial: true,
  };

  it('shows credit recharges with their status and an admin-only note', () => {
    expect(adminLedgerRowSchema.parse(credit)).toEqual(credit);
    expect(adminLedgerRowSchema.parse(recharge)).toEqual(recharge);
    for (const wrong of [
      { ...credit, noteVisibility: 'customer' },
      { ...credit, paymentStatus: null },
      { ...recharge, paymentStatus: 'pending' },
      { ...recharge, noteVisibility: 'admin' },
      { ...recharge, actor: null },
    ])
      expect(adminLedgerRowSchema.safeParse(wrong).success).toBe(false);
  });

  it('uses the same merged charge row as the portal', () => {
    expect(adminLedgerRowSchema.parse(charge)).toEqual(charge);
    expect(portalLedgerRowSchema.parse(charge)).toEqual(charge);
    expect(mergedChargeRowSchema.parse(charge)).toEqual(charge);
  });

  it('filters by all five kinds, pages like the old ledger, and caps the range', () => {
    expect(
      adminLedgerQuerySchema.parse({ ...range, kind: 'credit_recharge' }),
    ).toEqual({ ...range, kind: 'credit_recharge', page: 1, pageSize: 25 });
    expect(
      adminLedgerQuerySchema.parse({ ...range, kind: 'call_charge' }).kind,
    ).toBe('call_charge');
    expect(
      adminLedgerQuerySchema.safeParse({ ...range, pageSize: 101 }).success,
    ).toBe(false);
    expect(
      adminLedgerQuerySchema.safeParse({
        from: '2026-09-01',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
  });

  it('responds with the page, the current balance and the filtered total', () => {
    const response = {
      currency: 'CNY',
      balance: '-35.2',
      totalAmount: '411.36',
      items: [charge, credit],
      pagination: { page: 1, pageSize: 25, total: 2 },
    };
    expect(adminLedgerResponseSchema.parse(response)).toEqual(response);
  });
});

describe('cdr_export audit', () => {
  const payload = {
    id,
    action: 'cdr_export',
    actor: { id, name: '管理员' },
    occurredAt: '2026-10-17T10:00:00Z',
    tenantId: id,
    target: { kind: 'tenant', id },
    content: {
      summary: '导出话单',
      changes: [],
      rowCount: 286,
      filters: {
        from: '2026-09-27',
        to: '2026-09-27',
        status: 'all',
        callee: '447700900123',
        unverifiedOnly: true,
      },
    },
  };

  it('records the tenant, the filters and the row count', () => {
    expect(auditPayloadSchema.parse(payload)).toEqual(payload);
    expect(
      auditPayloadSchema.safeParse({
        ...payload,
        content: { ...payload.content, rowCount: undefined },
      }).success,
    ).toBe(false);
    expect(
      auditPayloadSchema.safeParse({
        ...payload,
        content: {
          ...payload.content,
          filters: { ...payload.content.filters, callee: '+44 7700' },
        },
      }).success,
    ).toBe(false);
    expect(
      auditPayloadSchema.safeParse({
        ...payload,
        content: { ...payload.content, rowCount: -1 },
      }).success,
    ).toBe(false);
  });
});

describe('admin CDR operations', () => {
  it('are admin-only, tenant scoped by the path, and POST for the audited export', () => {
    expect(
      Object.values(adminCdrApiContract).map((op) => `${op.method} ${op.path}`),
    ).toEqual([
      'GET /api/admin/tenants/{tenantId}/cdrs',
      'GET /api/admin/tenants/{tenantId}/cdrs/countries',
      'POST /api/admin/tenants/{tenantId}/cdrs/export',
    ]);
    for (const op of Object.values(adminCdrApiContract)) {
      expect(op.access).toBe('admin');
      expect(op.isolationCase).toBe('admin-only');
      expect(op.request.params.parse({ tenantId: id })).toEqual({
        tenantId: id,
      });
      expect(op.request.params.safeParse({}).success).toBe(false);
    }
  });

  it('stay out of the registered admin contract until the backend lands', () => {
    for (const key of Object.keys(adminCdrApiContract))
      expect(key in adminApiContract).toBe(false);
  });
});
