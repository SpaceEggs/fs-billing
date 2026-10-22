import { describe, expect, it } from 'vitest';
import {
  adminApiContract,
  adminApiErrorSchema,
  adminApiErrorStatus,
  adminStatementApiContract,
  adminStatementGroupSchema,
  adminStatementRegenerateRequestSchema,
  adminStatementRegenerateResponseSchema,
  adminStatementsQuerySchema,
  adminStatementsResponseSchema,
  adminTenantStatementResponseSchema,
  adminTenantStatementRowSchema,
  adminTenantStatementsResponseSchema,
  addDecimalStrings,
  apiContract,
  auditActionSchema,
  auditPayloadSchema,
  exportFilename,
  negateDecimalString,
  portalApiContract,
  portalStatementApiContract,
  portalStatementResponseSchema,
  portalStatementRowSchema,
  portalStatementsResponseSchema,
  statementFiguresBalance,
  statementMonthParamsSchema,
} from './index.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const adminId = '660e8400-e29b-41d4-a716-446655440000';
const generated = '2026-10-01T18:00:03.000Z';
const septemberFigures = {
  openingBalance: '1176.6',
  recharge: '1300',
  gift: '0',
  adjustment: '-25.5',
  callCharges: '2486.3',
  closingBalance: '-35.2',
  calls: 12804,
  callMinutes: '49726',
};
const final = {
  month: '2026-09',
  state: 'final',
  figures: septemberFigures,
  generatedAt: generated,
  detailsDeleted: false,
};
const live = {
  month: '2026-10',
  state: 'in_progress',
  figures: {
    openingBalance: '-35.2',
    recharge: '3.51',
    gift: '0',
    adjustment: '0',
    callCharges: '3.51',
    closingBalance: '-35.2',
    calls: 20,
    callMinutes: '81',
  },
  generatedAt: null,
  detailsDeleted: false,
};
const portalDetail = {
  currency: 'CNY',
  tenant: { code: 'ABC001', name: '华南贸易' },
  month: '2026-09',
  state: 'final',
  period: { from: '2026-09-01', to: '2026-09-30', openedOn: null },
  asOf: null,
  generatedAt: generated,
  detailsDeleted: false,
  figures: septemberFigures,
  countries: [
    { country: '中国', calls: 9000, minutes: '30000', charge: '1500' },
    { country: '牙买加', calls: 3804, minutes: '19726', charge: '986.3' },
  ],
  days: [
    { day: '2026-09-01', calls: 400, minutes: '1600', charge: '80.1' },
    { day: '2026-09-02', calls: 410, minutes: '1650', charge: '82' },
  ],
};
const adminRowFields = {
  firstGeneratedAt: generated,
  version: 1,
  reconcileStatus: 'ok',
  regenerable: { allowed: true, reason: null },
};
const tenant = { id, code: 'ABC001', name: '华南贸易' };
const adminDetail = {
  ...portalDetail,
  tenant,
  firstGeneratedAt: generated,
  version: 1,
  generatedBy: null,
  reconcile: { status: 'ok', reconciledAt: generated, diff: null },
  breakdownGap: '0',
  regenerable: { allowed: true, reason: null },
};
const versioned = { ...septemberFigures, version: 1 };

describe('statement figures', () => {
  it('require the closing balance to equal the signed formula exactly', () => {
    expect(statementFiguresBalance(septemberFigures)).toBe(true);
    expect(
      statementFiguresBalance({
        ...septemberFigures,
        closingBalance: '-35.21',
      }),
    ).toBe(false);
    expect(
      statementFiguresBalance({
        openingBalance: '0.0001',
        recharge: '0',
        gift: '0',
        adjustment: '0',
        callCharges: '0.0001',
        closingBalance: '0',
      }),
    ).toBe(true);
  });

  it('adds and negates decimal strings without rounding', () => {
    expect(addDecimalStrings(['0.1', '0.2'])).toBe('0.3');
    expect(addDecimalStrings(['1176.6', '1300', '0', '-25.5', '-2486.3'])).toBe(
      '-35.2',
    );
    expect(addDecimalStrings([])).toBe('0');
    expect(addDecimalStrings(['0.0001', '-0.0001'])).toBe('0');
    expect(negateDecimalString('2486.3')).toBe('-2486.3');
    expect(negateDecimalString('-25.5')).toBe('25.5');
    expect(negateDecimalString('0')).toBe('0');
    expect(negateDecimalString('0.00')).toBe('0');
  });
});

describe('portal statement schemas', () => {
  it('accept the mockup rows and list ordered by month descending', () => {
    expect(portalStatementRowSchema.parse(final)).toEqual(final);
    const list = {
      currency: 'CNY',
      items: [live, final],
      asOf: generated,
    };
    expect(portalStatementsResponseSchema.parse(list)).toEqual(list);
    expect(
      portalStatementsResponseSchema.safeParse({
        ...list,
        items: [final, live],
      }).success,
    ).toBe(false);
    expect(
      portalStatementsResponseSchema.safeParse({ ...list, items: [] }).success,
    ).toBe(false);
  });

  it('reject a row whose closing balance breaks the formula', () => {
    expect(
      portalStatementRowSchema.safeParse({
        ...final,
        figures: { ...septemberFigures, closingBalance: '-35.19' },
      }).success,
    ).toBe(false);
  });

  it('tie generatedAt, asOf and detailsDeleted to the state', () => {
    expect(
      portalStatementRowSchema.safeParse({ ...final, generatedAt: null })
        .success,
    ).toBe(false);
    expect(
      portalStatementRowSchema.safeParse({ ...live, generatedAt: generated })
        .success,
    ).toBe(false);
    expect(
      portalStatementRowSchema.safeParse({ ...live, detailsDeleted: true })
        .success,
    ).toBe(false);
    expect(
      portalStatementRowSchema.safeParse({ ...final, detailsDeleted: true })
        .success,
    ).toBe(true);
    expect(
      portalStatementResponseSchema.safeParse({
        ...portalDetail,
        asOf: generated,
      }).success,
    ).toBe(false);
    expect(
      portalStatementResponseSchema.safeParse({
        ...portalDetail,
        state: 'pending',
        generatedAt: null,
        asOf: null,
      }).success,
    ).toBe(false);
  });

  it('parse the detail and cannot represent admin-only or internal fields', () => {
    expect(portalStatementResponseSchema.parse(portalDetail)).toEqual(
      portalDetail,
    );
    for (const extra of [
      { version: 1 },
      { generatedBy: null },
      { reconcile: { status: 'ok' } },
      { reconcileStatus: 'ok' },
      { breakdownGap: '0' },
      { firstGeneratedAt: generated },
      { tenantId: id },
      { regenerable: { allowed: true, reason: null } },
    ])
      expect(
        portalStatementResponseSchema.safeParse({ ...portalDetail, ...extra })
          .success,
        JSON.stringify(extra),
      ).toBe(false);
    expect(
      portalStatementResponseSchema.safeParse({
        ...portalDetail,
        tenant: { ...portalDetail.tenant, id },
      }).success,
    ).toBe(false);
    for (const extra of [{ version: 1 }, { reconcileStatus: 'ok' }])
      expect(
        portalStatementRowSchema.safeParse({ ...final, ...extra }).success,
      ).toBe(false);
  });

  it('require unique countries and ascending unique days', () => {
    const country = portalDetail.countries[0];
    expect(
      portalStatementResponseSchema.safeParse({
        ...portalDetail,
        countries: [country, country],
      }).success,
    ).toBe(false);
    const day = portalDetail.days[1];
    expect(
      portalStatementResponseSchema.safeParse({
        ...portalDetail,
        days: [day, portalDetail.days[0]],
      }).success,
    ).toBe(false);
  });
});

describe('statement month parameter', () => {
  it('accepts YYYY-MM only and is strict', () => {
    expect(statementMonthParamsSchema.parse({ month: '2026-09' })).toEqual({
      month: '2026-09',
    });
    for (const month of [
      '2026-9',
      '2026-13',
      '2026-00',
      '2026-09-01',
      '0000-01',
      'abc',
      '',
    ])
      expect(
        statementMonthParamsSchema.safeParse({ month }).success,
        month,
      ).toBe(false);
    expect(
      statementMonthParamsSchema.safeParse({ month: '2026-09', tenantId: id })
        .success,
    ).toBe(false);
  });

  it('keeps the optional admin list month strict', () => {
    expect(adminStatementsQuerySchema.parse({})).toEqual({});
    expect(adminStatementsQuerySchema.parse({ month: '2026-09' })).toEqual({
      month: '2026-09',
    });
    expect(
      adminStatementsQuerySchema.safeParse({ month: '2026-09', extra: '1' })
        .success,
    ).toBe(false);
  });
});

describe('admin statement schemas', () => {
  const finalRow = { ...final, ...adminRowFields };
  const liveRow = {
    ...live,
    firstGeneratedAt: null,
    version: 0,
    reconcileStatus: null,
    regenerable: { allowed: false, reason: 'in_progress' },
  };
  const pendingRow = {
    tenant,
    month: '2026-09',
    state: 'pending',
    figures: null,
    generatedAt: null,
    firstGeneratedAt: null,
    version: 0,
    detailsDeleted: false,
    reconcileStatus: null,
    regenerable: { allowed: true, reason: null },
  };
  const listRow = { ...finalRow, tenant };

  it('lists the tenant months with the stale and inconsistent states exposed', () => {
    expect(adminTenantStatementRowSchema.parse(finalRow)).toEqual(finalRow);
    for (const reconcileStatus of ['unchecked', 'stale', 'inconsistent'])
      expect(
        adminTenantStatementRowSchema.parse({ ...finalRow, reconcileStatus })
          .reconcileStatus,
      ).toBe(reconcileStatus);
    const response = {
      currency: 'CNY',
      tenant,
      asOf: generated,
      items: [liveRow, finalRow],
    };
    expect(adminTenantStatementsResponseSchema.parse(response)).toEqual(
      response,
    );
  });

  it('derives regenerable from the state and the deleted flag', () => {
    expect(
      adminTenantStatementRowSchema.safeParse({
        ...finalRow,
        detailsDeleted: true,
        regenerable: { allowed: false, reason: 'details_deleted' },
      }).success,
    ).toBe(true);
    for (const regenerable of [
      { allowed: false, reason: null },
      { allowed: true, reason: 'details_deleted' },
      { allowed: false, reason: 'in_progress' },
    ])
      expect(
        adminTenantStatementRowSchema.safeParse({ ...finalRow, regenerable })
          .success,
      ).toBe(false);
    expect(
      adminTenantStatementRowSchema.safeParse({
        ...liveRow,
        regenerable: { allowed: true, reason: null },
      }).success,
    ).toBe(false);
  });

  it('ties version, first generation and reconcile status to stored statements', () => {
    expect(
      adminTenantStatementRowSchema.safeParse({ ...finalRow, version: 0 })
        .success,
    ).toBe(false);
    expect(
      adminTenantStatementRowSchema.safeParse({ ...liveRow, version: 1 })
        .success,
    ).toBe(false);
    expect(
      adminTenantStatementRowSchema.safeParse({
        ...liveRow,
        reconcileStatus: 'ok',
      }).success,
    ).toBe(false);
    expect(
      adminTenantStatementRowSchema.safeParse({
        ...finalRow,
        reconcileStatus: null,
      }).success,
    ).toBe(false);
  });

  it('groups month rows by currency with totals and pending rows without figures', () => {
    const totals = septemberFigures;
    const group = {
      currency: 'CNY',
      tenantCount: 2,
      totals,
      items: [listRow, pendingRow],
    };
    expect(adminStatementGroupSchema.parse(group)).toEqual(group);
    const response = {
      month: '2026-09',
      asOf: generated,
      groups: [group],
    };
    expect(adminStatementsResponseSchema.parse(response)).toEqual(response);
    expect(
      adminStatementsResponseSchema.parse({ ...response, groups: [] }).groups,
    ).toEqual([]);
    expect(
      adminStatementsResponseSchema.safeParse({
        ...response,
        groups: [{ ...group, tenantCount: 1 }],
      }).success,
    ).toBe(false);
    expect(
      adminStatementsResponseSchema.safeParse({
        ...response,
        groups: [group, group],
      }).success,
    ).toBe(false);
    expect(
      adminStatementsResponseSchema.safeParse({
        ...response,
        month: '2026-08',
      }).success,
    ).toBe(false);
    expect(
      adminStatementGroupSchema.safeParse({
        ...group,
        items: [{ ...pendingRow, figures: septemberFigures }],
        tenantCount: 1,
      }).success,
    ).toBe(false);
    expect(
      adminStatementGroupSchema.safeParse({
        ...group,
        items: [{ ...listRow, state: 'pending' }],
        tenantCount: 1,
      }).success,
    ).toBe(false);
    expect(
      adminStatementGroupSchema.safeParse({
        ...group,
        items: [{ ...listRow, state: 'in_progress' }],
        tenantCount: 1,
      }).success,
    ).toBe(false);
  });

  it('parses the detail with reconcile, generator, breakdown gap and regenerable', () => {
    expect(adminTenantStatementResponseSchema.parse(adminDetail)).toEqual(
      adminDetail,
    );
    const regenerated = {
      ...adminDetail,
      version: 2,
      generatedBy: { id: adminId, name: '管理员' },
      reconcile: { status: 'stale', reconciledAt: generated, diff: '-1.5' },
      breakdownGap: '240.75',
    };
    expect(adminTenantStatementResponseSchema.parse(regenerated)).toEqual(
      regenerated,
    );
    const liveDetail = {
      ...adminDetail,
      state: 'in_progress',
      asOf: generated,
      generatedAt: null,
      firstGeneratedAt: null,
      version: 0,
      generatedBy: null,
      reconcile: null,
      regenerable: { allowed: false, reason: 'in_progress' },
    };
    expect(adminTenantStatementResponseSchema.parse(liveDetail)).toEqual(
      liveDetail,
    );
    expect(
      adminTenantStatementResponseSchema.safeParse({
        ...liveDetail,
        reconcile: adminDetail.reconcile,
      }).success,
    ).toBe(false);
    expect(
      adminTenantStatementResponseSchema.safeParse({
        ...adminDetail,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('requires a non-negative integer expectedVersion and no account id', () => {
    expect(
      adminStatementRegenerateRequestSchema.parse({ expectedVersion: 0 }),
    ).toEqual({ expectedVersion: 0 });
    for (const body of [
      {},
      { expectedVersion: -1 },
      { expectedVersion: 1.5 },
      { expectedVersion: '1' },
      { expectedVersion: 1, statementId: id },
    ])
      expect(
        adminStatementRegenerateRequestSchema.safeParse(body).success,
        JSON.stringify(body),
      ).toBe(false);
  });

  it('describes regenerate, backfill and no-op outcomes', () => {
    const changed = {
      auditId: id,
      month: '2026-09',
      created: false,
      changed: true,
      before: versioned,
      after: {
        ...versioned,
        version: 2,
        callCharges: '2486.4',
        closingBalance: '-35.3',
      },
      staleFollowingMonths: ['2026-10'],
    };
    expect(adminStatementRegenerateResponseSchema.parse(changed)).toEqual(
      changed,
    );
    const unchanged = {
      ...changed,
      changed: false,
      after: versioned,
      staleFollowingMonths: [],
    };
    expect(adminStatementRegenerateResponseSchema.parse(unchanged)).toEqual(
      unchanged,
    );
    const backfilled = {
      ...changed,
      created: true,
      before: null,
      after: versioned,
    };
    expect(adminStatementRegenerateResponseSchema.parse(backfilled)).toEqual(
      backfilled,
    );
    expect(
      adminStatementRegenerateResponseSchema.safeParse({
        ...backfilled,
        created: false,
      }).success,
    ).toBe(false);
    expect(
      adminStatementRegenerateResponseSchema.safeParse({
        ...changed,
        created: true,
      }).success,
    ).toBe(false);
    expect(
      adminStatementRegenerateResponseSchema.safeParse({
        ...changed,
        changed: false,
      }).success,
    ).toBe(false);
    expect(
      adminStatementRegenerateResponseSchema.safeParse({
        ...changed,
        auditId: undefined,
      }).success,
    ).toBe(false);
  });
});

describe('statement audit and conflicts', () => {
  const audit = {
    id,
    actor: { id: adminId, name: '管理员' },
    occurredAt: generated,
    tenantId: id,
    target: { kind: 'statement', id },
    action: 'statement_regenerate',
    content: {
      summary: '重新生成 ABC001 2026-09 账单',
      changes: [],
      month: '2026-09',
      created: false,
      changed: true,
      before: versioned,
      after: { ...versioned, version: 2 },
    },
  };

  it('has a statement_regenerate action with before and after figures', () => {
    expect(auditActionSchema.options).toContain('statement_regenerate');
    expect(auditPayloadSchema.parse(audit)).toEqual(audit);
    expect(
      auditPayloadSchema.safeParse({
        ...audit,
        content: { ...audit.content, before: undefined },
      }).success,
    ).toBe(false);
    expect(
      auditPayloadSchema.safeParse({
        ...audit,
        target: { kind: 'tenant', id },
      }).success,
    ).toBe(true);
    expect(
      auditPayloadSchema.safeParse({
        ...audit,
        content: { ...audit.content, before: null, created: true },
      }).success,
    ).toBe(true);
  });

  it('adds three 409 conflict codes', () => {
    for (const code of [
      'STATEMENT_DETAILS_DELETED',
      'STATEMENT_NOT_FINAL',
      'STATEMENT_VERSION_CONFLICT',
    ]) {
      expect(
        adminApiErrorStatus[code as keyof typeof adminApiErrorStatus],
      ).toBe(409);
      expect(
        adminApiErrorSchema.safeParse({
          error: { code, message: 'x', requestId: 'r' },
        }).success,
      ).toBe(true);
    }
    const responses =
      adminStatementApiContract.adminTenantStatementRegenerate.responses[409];
    expect(
      responses.safeParse({
        error: {
          code: 'STATEMENT_VERSION_CONFLICT',
          message: 'x',
          requestId: 'r',
        },
      }).success,
    ).toBe(true);
    expect(
      responses.safeParse({
        error: { code: 'TENANT_CODE_EXISTS', message: 'x', requestId: 'r' },
      }).success,
    ).toBe(false);
  });
});

describe('statement operations', () => {
  it('registers three customer reads isolated by RLS', () => {
    expect(
      Object.values(portalStatementApiContract).map(
        (op) => `${op.method} ${op.path}`,
      ),
    ).toEqual([
      'GET /api/portal/statements',
      'GET /api/portal/statements/{month}',
      'POST /api/portal/statements/{month}/export',
    ]);
    for (const op of Object.values(portalStatementApiContract)) {
      expect(op.access).toBe('customer');
      expect(op.isolationCase).toBe('tenant-read');
      expect(Object.keys(portalApiContract)).toContain(op.operationId);
      expect(op.request.params.safeParse({ tenantId: id }).success).toBe(false);
    }
    expect(
      portalStatementApiContract.portalStatement.request.params.parse({
        month: '2026-09',
      }),
    ).toEqual({ month: '2026-09' });
    expect(
      portalStatementApiContract.portalStatement.request.params.safeParse({
        month: '2026-09',
        tenantId: id,
      }).success,
    ).toBe(false);
    expect(
      portalStatementApiContract.portalStatementExport.responses[200].parse(
        'a',
      ),
    ).toBe('a');
  });

  it('registers five admin operations outside the aggregate admin contract', () => {
    expect(
      Object.values(adminStatementApiContract).map(
        (op) => `${op.method} ${op.path}`,
      ),
    ).toEqual([
      'GET /api/admin/statements',
      'GET /api/admin/tenants/{tenantId}/statements',
      'GET /api/admin/tenants/{tenantId}/statements/{month}',
      'POST /api/admin/tenants/{tenantId}/statements/{month}/export',
      'POST /api/admin/tenants/{tenantId}/statements/{month}/regenerate',
    ]);
    for (const op of Object.values(adminStatementApiContract)) {
      expect(op.access).toBe('admin');
      expect(op.isolationCase).toBe('admin-only');
      expect(op.operationId in adminApiContract).toBe(false);
      expect(op.operationId in apiContract).toBe(false);
    }
    const detail =
      adminStatementApiContract.adminTenantStatement.request.params;
    expect(detail.parse({ tenantId: id, month: '2026-09' })).toEqual({
      tenantId: id,
      month: '2026-09',
    });
    expect(detail.safeParse({ tenantId: id }).success).toBe(false);
    expect(detail.safeParse({ month: '2026-09' }).success).toBe(false);
    expect(
      detail.safeParse({ tenantId: id, month: '2026-09', extra: 1 }).success,
    ).toBe(false);
    expect(
      adminStatementApiContract.adminTenantStatementRegenerate.request.body.safeParse(
        {
          expectedVersion: 1,
        },
      ).success,
    ).toBe(true);
  });

  it('names the summary export after the tenant code and the month range', () => {
    expect(
      exportFilename('statement', 'ABC001', {
        from: '2026-09-01',
        to: '2026-09-30',
      }),
    ).toBe('statement_ABC001_2026-09-01_2026-09-30.csv');
  });
});
