import { describe, expect, it } from 'vitest';
import {
  adminApiErrorStatus,
  adminAuditLogApiContract,
  adminAuditLogsQuerySchema,
  adminAuditLogsResponseSchema,
  adminCdrDeleteRequestSchema,
  adminCdrDeleteResponseSchema,
  adminCdrDeletionApiContract,
  adminCdrDeletionMonthsResponseSchema,
  adminUnassignedApiContract,
  adminUnassignedAssignRequestSchema,
  adminUnassignedIgnoreRequestSchema,
  adminUnassignedListQuerySchema,
  adminUnassignedPreviewRequestSchema,
  auditActionSchema,
  auditLabelActions,
  auditLabelOf,
  auditLabelSchema,
  auditPayloadSchema,
  unassignedSelectionSchema,
} from './index.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
const other = '660e8400-e29b-41d4-a716-446655440000';
const at = '2026-10-23T02:15:36.000Z';

describe('unassigned selection and requests', () => {
  it('takes ticked ids or a whole tag group, and nothing else', () => {
    expect(unassignedSelectionSchema.parse({ ids: [id] })).toEqual({
      ids: [id],
    });
    expect(
      unassignedSelectionSchema.parse({ group: { tag: 'ABC01' } }),
    ).toEqual({ group: { tag: 'ABC01' } });
    // 空串是标签为空的分组。
    expect(unassignedSelectionSchema.parse({ group: { tag: '' } })).toEqual({
      group: { tag: '' },
    });
    for (const wrong of [
      {},
      { ids: [] },
      { ids: ['not-a-uuid'] },
      { ids: [id], group: { tag: 'ABC01' } },
      { group: {} },
      { group: { tag: 'x'.repeat(201) } },
      { ids: Array.from({ length: 2001 }, () => id) },
    ])
      expect(
        unassignedSelectionSchema.safeParse(wrong).success,
        JSON.stringify(wrong).slice(0, 60),
      ).toBe(false);
  });

  it('requires an idempotency key and the preview figures to assign', () => {
    const body = {
      tenantId: id,
      selection: { group: { tag: 'ABC01' } },
      idempotencyKey: 'k1',
      expected: { assignable: 324, noRate: 2, chargeTotal: '58.35' },
    };
    expect(adminUnassignedAssignRequestSchema.parse(body)).toEqual(body);
    for (const wrong of [
      { ...body, idempotencyKey: '  ' },
      { ...body, expected: { ...body.expected, chargeTotal: '-1' } },
      { ...body, expected: { assignable: 324, noRate: 2 } },
      { ...body, tenantId: 'ABC001' },
      { ...body, extra: 1 },
    ])
      expect(adminUnassignedAssignRequestSchema.safeParse(wrong).success).toBe(
        false,
      );
    expect(
      adminUnassignedPreviewRequestSchema.safeParse({
        tenantId: id,
        selection: { ids: [id] },
      }).success,
    ).toBe(true);
  });

  it('trims the ignore reason and refuses an empty one', () => {
    const selection = { ids: [id] };
    expect(
      adminUnassignedIgnoreRequestSchema.parse({ selection, reason: ' 测试 ' })
        .reason,
    ).toBe('测试');
    for (const reason of ['', '   ', 'x'.repeat(2001)])
      expect(
        adminUnassignedIgnoreRequestSchema.safeParse({ selection, reason })
          .success,
      ).toBe(false);
  });

  it('lists pending by default and tells an empty tag from no tag', () => {
    expect(adminUnassignedListQuerySchema.parse({})).toMatchObject({
      status: 'pending',
      page: 1,
      pageSize: 25,
    });
    expect(adminUnassignedListQuerySchema.parse({}).tag).toBeUndefined();
    expect(adminUnassignedListQuerySchema.parse({ tag: '' }).tag).toBe('');
    expect(
      adminUnassignedListQuerySchema.safeParse({ status: 'assigned' }).success,
    ).toBe(false);
  });
});

describe('cdr deletion contract', () => {
  it('needs the tenant code and the previewed count', () => {
    const body = {
      fromMonth: '2026-08',
      toMonth: '2026-08',
      tenantCode: 'ABC001',
      expectedCount: 9642,
    };
    expect(adminCdrDeleteRequestSchema.parse(body)).toEqual(body);
    for (const wrong of [
      { ...body, fromMonth: '2026-8' },
      { ...body, tenantCode: '' },
      { ...body, expectedCount: -1 },
      { ...body, expectedCount: 1.5 },
    ])
      expect(adminCdrDeleteRequestSchema.safeParse(wrong).success).toBe(false);
  });

  it('describes exactly twelve months', () => {
    const month = (n: number) => ({
      month: `2026-${String(n).padStart(2, '0')}`,
      state: 'future',
      cdrCount: null,
      blockedReasons: [],
      statementId: null,
      deleted: null,
    });
    const response = {
      tenant: { id, code: 'ABC001', name: '深圳' },
      year: 2026,
      months: Array.from({ length: 12 }, (_, i) => month(i + 1)),
    };
    expect(adminCdrDeletionMonthsResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      adminCdrDeletionMonthsResponseSchema.safeParse({
        ...response,
        months: response.months.slice(1),
      }).success,
    ).toBe(false);
  });

  it('reports a partial deletion with the first unprocessed month as the failure', () => {
    const done = {
      month: '2026-07',
      deleted: 5,
      statementId: id,
      auditId: other,
    };
    const ok = { months: [done], total: 5, remaining: [], failure: null };
    expect(adminCdrDeleteResponseSchema.parse(ok)).toEqual(ok);
    const partial = {
      months: [done],
      total: 5,
      remaining: ['2026-08', '2026-09'],
      failure: { month: '2026-08', code: 'INTERNAL', message: '服务内部错误' },
    };
    expect(adminCdrDeleteResponseSchema.parse(partial)).toEqual(partial);
    for (const wrong of [
      { ...partial, failure: null },
      { ...ok, remaining: ['2026-08'] },
      { ...partial, remaining: ['2026-09', '2026-08'] },
      { ...partial, months: [] },
    ])
      expect(adminCdrDeleteResponseSchema.safeParse(wrong).success).toBe(false);
  });
});

describe('audit log contract', () => {
  it('puts every audit action under exactly one label', () => {
    const labelled = auditLabelSchema.options.flatMap(
      (label) => auditLabelActions[label],
    );
    expect([...labelled].sort()).toEqual([...auditActionSchema.options].sort());
    expect(new Set(labelled).size).toBe(labelled.length);
    for (const action of auditActionSchema.options)
      expect(auditLabelActions[auditLabelOf(action)]).toContain(action);
  });

  it('defaults to 50 rows a page and refuses a reversed range', () => {
    expect(adminAuditLogsQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 50,
    });
    expect(
      adminAuditLogsQuerySchema.safeParse({
        from: '2026-09-29',
        to: '2026-08-31',
      }).success,
    ).toBe(false);
    expect(adminAuditLogsQuerySchema.safeParse({ label: 'nope' }).success).toBe(
      false,
    );
    expect(
      adminAuditLogsQuerySchema.parse({ label: 'cdr_delete', tenantId: id })
        .label,
    ).toBe('cdr_delete');
  });

  it('shows an administrator or the label of a command line event', () => {
    const base = {
      id,
      occurredAt: at,
      action: 'cdr_delete',
      label: 'cdr_delete',
      tenant: { id, code: 'ABC001', name: '深圳' },
      target: { kind: 'statement', id },
      summary: '删除话单',
      changes: [{ field: 'callCount', before: '9642', after: '0' }],
    };
    const response = {
      range: { from: '2026-08-31', to: '2026-09-29' },
      items: [
        { ...base, actor: { kind: 'admin', id, name: '王敏' } },
        {
          ...base,
          action: 'credential_bootstrap',
          label: 'account',
          tenant: null,
          actor: { kind: 'system', label: 'cli:auth:bootstrap@host/ops' },
        },
      ],
      pagination: { page: 1, pageSize: 50, total: 2 },
    };
    expect(adminAuditLogsResponseSchema.parse(response)).toEqual(response);
    expect(
      adminAuditLogsResponseSchema.safeParse({
        ...response,
        items: [{ ...base, actor: { kind: 'system' } }],
      }).success,
    ).toBe(false);
  });
});

describe('credential_bootstrap audit', () => {
  const event = {
    id,
    actor: { label: 'cli:auth:bootstrap@host/ops' },
    occurredAt: at,
    tenantId: null,
    target: { kind: 'admin', id: other },
    action: 'credential_bootstrap',
    content: {
      summary: '创建管理员凭据',
      changes: [],
      mode: 'create',
      result: 'succeeded',
      errorCode: null,
      revokedSessions: 0,
    },
  };

  it('records the command line source instead of an administrator', () => {
    expect(auditPayloadSchema.parse(event)).toEqual(event);
    expect(
      auditPayloadSchema.safeParse({
        ...event,
        actor: { id, name: '王敏' },
      }).success,
    ).toBe(false);
    // 管理员操作不能冒用命令行来源。
    expect(
      auditPayloadSchema.safeParse({
        ...event,
        action: 'tenant_edit',
        actor: { label: 'cli' },
        content: { summary: 'x', changes: [] },
      }).success,
    ).toBe(false);
  });

  it('has no place for a password, a hash, a token or an error message', () => {
    for (const field of ['password', 'hash', 'token', 'message', 'error'])
      expect(
        auditPayloadSchema.safeParse({
          ...event,
          content: { ...event.content, [field]: 'secret' },
        }).success,
        field,
      ).toBe(false);
    expect(
      auditPayloadSchema.safeParse({
        ...event,
        content: { ...event.content, result: 'rejected', errorCode: 'oops' },
      }).success,
    ).toBe(false);
    expect(
      auditPayloadSchema.safeParse({
        ...event,
        content: {
          ...event.content,
          result: 'rejected',
          errorCode: 'CREDENTIAL_EXISTS',
        },
      }).success,
    ).toBe(true);
  });
});

describe('phase 8 operations', () => {
  it('registers ten admin-only operations, all answering 409s with known codes', () => {
    const contract = {
      ...adminUnassignedApiContract,
      ...adminCdrDeletionApiContract,
      ...adminAuditLogApiContract,
    };
    expect(Object.keys(contract)).toHaveLength(10);
    for (const operation of Object.values(contract)) {
      expect(operation.access).toBe('admin');
      expect(operation.isolationCase).toBe('admin-only');
    }
    for (const code of [
      'UNASSIGNED_PREVIEW_STALE',
      'UNASSIGNED_NOTHING_TO_ASSIGN',
      'CDR_MONTH_NOT_DELETABLE',
      'CDR_DELETE_COUNT_CHANGED',
    ] as const)
      expect(adminApiErrorStatus[code]).toBe(409);
  });
});
