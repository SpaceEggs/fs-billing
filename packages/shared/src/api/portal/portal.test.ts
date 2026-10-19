import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { apiContract } from '../contract.js';
import { adminApiContract } from '../admin/contract.js';
import * as adminSchemas from '../admin/index.js';
import { formatMergedChargeNote } from '../ledger-merge.js';
import {
  PORTAL_CREDIT_RECHARGE_NOTE,
  portalApiContract,
  portalCdrCountriesQuerySchema,
  portalCdrExportRequestSchema,
  portalCdrSchema,
  portalCdrsQuerySchema,
  portalCdrsResponseSchema,
  portalHomeResponseSchema,
  portalLedgerQuerySchema,
  portalLedgerResponseSchema,
  portalLedgerRowSchema,
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
};
const unanswered = {
  ...answered,
  answeredAt: null,
  country: null,
  matchedPrefix: null,
  durationSeconds: 0,
  billedMinutes: '0',
  rate: null,
  charge: '0',
  hangupCause: 'NO_ANSWER',
};
const range = { from: '2026-09-01', to: '2026-09-29' };

function propertyNames(node: unknown, found = new Set<string>()) {
  if (Array.isArray(node)) node.forEach((child) => propertyNames(child, found));
  else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === 'properties' && typeof child === 'object' && child !== null)
        Object.keys(child).forEach((name) => found.add(name));
      propertyNames(child, found);
    }
  }
  return found;
}
const wireNames = (schema: z.ZodType) =>
  propertyNames(
    z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }),
  );
const internalWords = [
  'unverified',
  'billing_unverified',
  'internalNote',
  'paymentStatus',
  'noteVisibility',
  'credit_recharge',
  'createdBy',
];
const schemaText = (schema: z.ZodType) =>
  JSON.stringify(
    z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }),
  );

describe('portal CDR rows', () => {
  it('parse answered and unanswered calls', () => {
    expect(portalCdrSchema.parse(answered)).toEqual(answered);
    expect(portalCdrSchema.parse(unanswered)).toEqual(unanswered);
  });

  it.each([
    ['unverified', { unverified: false }],
    ['unverified', { unverified: true }],
    ['billing_unverified', { billing_unverified: true }],
    ['status', { status: 'answered' }],
  ])('reject the extra key %s instead of dropping it', (_name, extra) => {
    expect(portalCdrSchema.safeParse({ ...answered, ...extra }).success).toBe(
      false,
    );
  });

  it('mirrors the cdrs check constraints', () => {
    expect(
      portalCdrSchema.safeParse({ ...unanswered, charge: '0.50' }).success,
    ).toBe(false);
    expect(
      portalCdrSchema.safeParse({ ...unanswered, durationSeconds: 3 }).success,
    ).toBe(false);
    expect(
      portalCdrSchema.safeParse({ ...answered, country: null }).success,
    ).toBe(false);
    expect(
      portalCdrSchema.safeParse({
        ...answered,
        answeredAt: '2026-09-27T03:20:00.000Z',
      }).success,
    ).toBe(false);
    expect(
      portalCdrSchema.safeParse({
        ...answered,
        endedAt: '2026-09-27T03:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('portal CDR list contract', () => {
  it('defaults to answered calls on page 1', () => {
    expect(portalCdrsQuerySchema.parse(range)).toEqual({
      ...range,
      status: 'answered',
      page: 1,
    });
  });

  it('caps the range at one month on the server', () => {
    expect(
      portalCdrsQuerySchema.safeParse({
        from: '2026-09-01',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
    expect(
      portalCdrExportRequestSchema.safeParse({
        from: '2026-08-01',
        to: '2026-09-30',
      }).success,
    ).toBe(false);
    expect(
      portalCdrCountriesQuerySchema.safeParse({
        from: '2026-09-01',
        to: '2026-09-30',
      }).success,
    ).toBe(true);
  });

  it.each([
    ['+44 7700 900123', '447700900123'],
    ['0086 138-0013 8000', '8613800138000'],
    ['(0755) 8600 1234', '75586001234'],
    ['  18765551234 ', '18765551234'],
  ])('normalizes the callee search %j to %s', (typed, normalized) => {
    expect(
      portalCdrsQuerySchema.parse({ ...range, callee: typed }).callee,
    ).toBe(normalized);
  });

  it.each(['abc', '000', '+', '1234567890123456', '44%', '12_3'])(
    'rejects the callee search %j',
    (typed) => {
      expect(
        portalCdrsQuerySchema.safeParse({ ...range, callee: typed }).success,
      ).toBe(false);
    },
  );

  it('rejects tenant and unknown parameters', () => {
    for (const extra of [
      { tenantId: id },
      { pageSize: 500 },
      { unverifiedOnly: 'true' },
    ])
      expect(
        portalCdrsQuerySchema.safeParse({ ...range, ...extra }).success,
      ).toBe(false);
  });

  it('puts the call count in pagination and keeps the summary free of it', () => {
    const response = {
      currency: 'CNY',
      items: [answered, unanswered],
      pagination: { page: 1, pageSize: 50, total: 13517 },
      summary: {
        billedMinutes: '49726',
        charge: '2486.3',
        unansweredCalls: 713,
      },
    };
    expect(portalCdrsResponseSchema.parse(response)).toEqual(response);
    expect(
      portalCdrsResponseSchema.safeParse({
        ...response,
        summary: { ...response.summary, calls: 13517 },
      }).success,
    ).toBe(false);
    expect(
      portalCdrsResponseSchema.safeParse({
        ...response,
        pagination: { page: 1, pageSize: 25, total: 2 },
      }).success,
    ).toBe(false);
  });
});

describe('portal ledger rows', () => {
  const recharge = {
    id,
    kind: 'recharge',
    amount: '500.00',
    balanceAfter: '500.00',
    occurredAt: '2026-09-23T02:15:36.000Z',
    note: PORTAL_CREDIT_RECHARGE_NOTE,
  };
  const charge = {
    kind: 'call_charge',
    day: '2026-09-28',
    calls: 356,
    amount: '-248.63',
    balanceAfter: '-35.2',
    occurredAt: '2026-09-28T15:59:58.000Z',
    partial: false,
  };

  it('parse manual and merged rows', () => {
    expect(portalLedgerRowSchema.parse(recharge)).toEqual(recharge);
    expect(portalLedgerRowSchema.parse(charge)).toEqual(charge);
    expect(
      portalLedgerRowSchema.parse({
        ...recharge,
        kind: 'gift',
        note: '',
      }).kind,
    ).toBe('gift');
  });

  it('cannot represent a credit recharge or its internal fields', () => {
    expect(
      portalLedgerRowSchema.safeParse({ ...recharge, kind: 'credit_recharge' })
        .success,
    ).toBe(false);
    for (const extra of [
      { internalNote: 'contract terms' },
      { paymentStatus: 'pending' },
      { noteVisibility: 'admin' },
      { actor: { id, name: '管理员' } },
    ])
      expect(
        portalLedgerRowSchema.safeParse({ ...recharge, ...extra }).success,
      ).toBe(false);
  });

  it('keeps the merged row on its Beijing day and the sign rules', () => {
    expect(
      portalLedgerRowSchema.safeParse({ ...charge, day: '2026-09-29' }).success,
    ).toBe(false);
    expect(
      portalLedgerRowSchema.safeParse({ ...charge, amount: '248.63' }).success,
    ).toBe(false);
    expect(
      portalLedgerRowSchema.safeParse({ ...charge, calls: 0 }).success,
    ).toBe(false);
    expect(
      portalLedgerRowSchema.safeParse({ ...recharge, amount: '-1' }).success,
    ).toBe(false);
    expect(
      portalLedgerRowSchema.safeParse({
        ...recharge,
        kind: 'adjustment',
        amount: '0.0000',
      }).success,
    ).toBe(false);
  });

  it.each(['bad', '2026-09-28T25:00:00Z'])(
    'reports a malformed merged-row time %j as an ordinary issue',
    (occurredAt) => {
      const result = portalLedgerRowSchema.safeParse({ ...charge, occurredAt });
      expect(result.success).toBe(false);
      expect(
        result.error?.issues.map((issue) => [issue.code, issue.path]),
      ).toEqual([['invalid_format', ['occurredAt']]]);
    },
  );

  it('writes the merged note the same way for the page and the CSV', () => {
    expect(formatMergedChargeNote(charge)).toBe(
      '2026-09-28 通话扣费，共 356 通',
    );
    expect(
      formatMergedChargeNote({
        ...charge,
        day: '2026-09-29',
        calls: 1702,
        partial: true,
      }),
    ).toBe('2026-09-29 通话扣费（截至当前），共 1,702 通');
  });

  it('filters by customer kinds and the same one-month range', () => {
    expect(
      portalLedgerQuerySchema.parse({ ...range, kind: 'recharge' }),
    ).toEqual({ ...range, kind: 'recharge', page: 1 });
    expect(
      portalLedgerQuerySchema.safeParse({ ...range, kind: 'credit_recharge' })
        .success,
    ).toBe(false);
    expect(
      portalLedgerQuerySchema.safeParse({
        from: '2026-09-01',
        to: '2026-10-01',
      }).success,
    ).toBe(false);
  });

  it('fixes the page size at 25 for the response', () => {
    const response = {
      currency: 'CNY',
      balance: '-35.2',
      totalAmount: '1300',
      items: [recharge, charge],
      pagination: { page: 1, pageSize: 25, total: 2 },
    };
    for (const pageSize of [100, 24, 26])
      expect(
        portalLedgerResponseSchema.safeParse({
          ...response,
          pagination: { page: 1, pageSize, total: 2 },
        }).success,
      ).toBe(false);
    expect(
      portalLedgerResponseSchema.safeParse({
        ...response,
        items: Array.from({ length: 26 }, () => recharge),
        pagination: { page: 1, pageSize: 25, total: 26 },
      }).success,
    ).toBe(false);
    expect(
      portalLedgerResponseSchema.safeParse({
        ...response,
        items: Array.from({ length: 25 }, () => recharge),
        pagination: { page: 1, pageSize: 25, total: 25 },
      }).success,
    ).toBe(true);
  });

  it('returns the balance and the filtered total beside the page', () => {
    const response = {
      currency: 'CNY',
      balance: '-35.2',
      totalAmount: '1300',
      items: [recharge, charge],
      pagination: { page: 1, pageSize: 25, total: 2 },
    };
    expect(portalLedgerResponseSchema.parse(response)).toEqual(response);
    expect(
      portalLedgerResponseSchema.safeParse({
        ...response,
        pagination: { page: 1, pageSize: 1, total: 2 },
      }).success,
    ).toBe(false);
  });
});

describe('portal home', () => {
  const daily = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 7, 31 + index));
    return { date: date.toISOString().slice(0, 10), spend: '0' };
  });
  const usage = {
    asOf: '2026-09-29T06:03:22.000Z',
    monthSpend: '2486.3',
    monthCallMinutes: '49726',
    answeredCalls: 12804,
    daily,
    dailyTotal: '0',
  };
  const home = {
    currency: 'CNY',
    balance: '-35.2',
    overdraftLimit: '100',
    availableBalance: '64.8',
    health: 'overdraft',
    usage,
    recentCalls: [answered],
  };

  it('parses and has no place for unanswered counts', () => {
    expect(portalHomeResponseSchema.parse(home)).toEqual(home);
    expect(
      portalHomeResponseSchema.safeParse({
        ...home,
        usage: { ...usage, unansweredCalls: 713 },
      }).success,
    ).toBe(false);
    expect(
      portalHomeResponseSchema.safeParse({
        ...home,
        usage: { ...usage, currency: 'CNY' },
      }).success,
    ).toBe(false);
  });

  it('keeps unverified out of recent calls and the 30-day window honest', () => {
    expect(
      portalHomeResponseSchema.safeParse({
        ...home,
        recentCalls: [{ ...answered, unverified: true }],
      }).success,
    ).toBe(false);
    expect(
      portalHomeResponseSchema.safeParse({
        ...home,
        usage: { ...usage, asOf: '2026-09-30T06:03:22.000Z' },
      }).success,
    ).toBe(false);
    expect(
      portalHomeResponseSchema.safeParse({
        ...home,
        recentCalls: Array.from({ length: 11 }, () => answered),
      }).success,
    ).toBe(false);
  });

  it('fails a malformed asOf as an ordinary issue', () => {
    const result = portalHomeResponseSchema.safeParse({
      ...home,
      usage: { ...usage, asOf: 'bad' },
    });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['usage', 'asOf'],
    ]);
  });

  it('shows answered calls only in recent calls', () => {
    const result = portalHomeResponseSchema.safeParse({
      ...home,
      recentCalls: [answered, unanswered],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ['recentCalls', 1, 'answeredAt'],
    ]);
    expect(
      portalHomeResponseSchema.parse({ ...home, recentCalls: [answered] })
        .recentCalls,
    ).toEqual([answered]);
  });

  it.each(['suspended', 'overdraft', 'low_balance', 'normal', 'disabled'])(
    'accepts the tenant health %s from the neutral module',
    (health) => {
      expect(portalHomeResponseSchema.parse({ ...home, health }).health).toBe(
        health,
      );
    },
  );
});

describe('portal operations', () => {
  const operations = Object.values(portalApiContract);

  it('are customer reads isolated by RLS, with unique ids and paths', () => {
    expect(operations.map((op) => `${op.method} ${op.path}`)).toEqual([
      'GET /api/portal/home',
      'GET /api/portal/cdrs',
      'GET /api/portal/cdrs/countries',
      'POST /api/portal/cdrs/export',
      'GET /api/portal/ledger',
      'POST /api/portal/ledger/export',
    ]);
    for (const op of operations) {
      expect(op.access).toBe('customer');
      expect(op.isolationCase).toBe('tenant-read');
    }
    const live: { operationId: string; method: string; path: string }[] = [
      ...Object.values(apiContract),
      ...Object.values(adminApiContract),
    ];
    for (const op of operations) {
      expect(live.some((other) => other.operationId === op.operationId)).toBe(
        false,
      );
      expect(
        live.some(
          (other) => other.path === op.path && other.method === op.method,
        ),
      ).toBe(false);
    }
  });

  it('never accept a tenant id from the request', () => {
    for (const op of operations) {
      expect(op.path).not.toContain('{');
      expect(wireNames(op.request.query)).not.toContain('tenantId');
    }
    for (const op of [
      portalApiContract.portalCdrsExport,
      portalApiContract.portalLedgerExport,
    ])
      expect(
        op.request.body.safeParse({ ...range, tenantId: id }).success,
      ).toBe(false);
  });

  it('streams CSV from POST exports and rejects an empty or admin-only body', () => {
    expect(portalApiContract.portalCdrsExport.responses[200].parse('a,b')).toBe(
      'a,b',
    );
    expect(
      portalApiContract.portalCdrsExport.request.body.parse(range),
    ).toEqual({ ...range, status: 'answered' });
    expect(
      portalApiContract.portalCdrsExport.request.body.safeParse({
        ...range,
        unverifiedOnly: true,
      }).success,
    ).toBe(false);
  });

  it('carry no internal field name anywhere in their responses', () => {
    const schemas = [
      portalCdrsResponseSchema,
      portalHomeResponseSchema,
      portalLedgerResponseSchema,
      portalCdrSchema,
      portalLedgerRowSchema,
    ];
    for (const schema of schemas) {
      for (const word of internalWords)
        expect(schemaText(schema), word).not.toContain(word);
      expect(wireNames(schema)).not.toContain('actor');
    }
    expect(wireNames(portalCdrsResponseSchema)).toContain('hangupCause');
  });

  it('do not reference any admin schema', () => {
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
    const customer = [
      ...Object.values(apiContract).filter((op) => op.access === 'customer'),
      ...operations,
    ];
    expect(customer.length).toBeGreaterThan(operations.length);
    for (const op of customer) {
      inspect(op.request);
      inspect(op.responses);
    }
  });
});
