import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  adminCdrCountriesQuerySchema,
  adminCdrExportRequestSchema,
  adminCdrsQuerySchema,
  adminMergedLedgerQuerySchema,
} from './admin/index.js';
import {
  portalCdrCountriesQuerySchema,
  portalCdrExportRequestSchema,
  portalCdrsQuerySchema,
  portalLedgerExportRequestSchema,
  portalLedgerQuerySchema,
} from './portal/index.js';

const range = { from: '2026-09-01', to: '2026-09-29' };
const filters = {
  ...range,
  callee: '+44 7700 900123',
  country: ' 牙买加 ',
  status: 'all',
};

/**
 * 路由用查询串解析一次，数据库服务入口再解析一次同一个 schema（与 listTenantLedger 一致），
 * 所以解析的输出必须能被同一个 schema 再次解析且不变。
 */
const cases: [string, z.ZodType, unknown, unknown][] = [
  [
    'portalCdrsQuerySchema',
    portalCdrsQuerySchema,
    { ...filters, page: '3' },
    {
      ...range,
      callee: '447700900123',
      country: '牙买加',
      status: 'all',
      page: 3,
    },
  ],
  [
    'portalCdrsQuerySchema defaults',
    portalCdrsQuerySchema,
    range,
    { ...range, status: 'answered', page: 1 },
  ],
  [
    'portalCdrCountriesQuerySchema',
    portalCdrCountriesQuerySchema,
    range,
    range,
  ],
  [
    'portalCdrExportRequestSchema',
    portalCdrExportRequestSchema,
    filters,
    { ...range, callee: '447700900123', country: '牙买加', status: 'all' },
  ],
  [
    'portalLedgerQuerySchema',
    portalLedgerQuerySchema,
    { ...range, kind: 'gift', page: '2' },
    { ...range, kind: 'gift', page: 2 },
  ],
  [
    'portalLedgerExportRequestSchema',
    portalLedgerExportRequestSchema,
    { ...range, kind: 'recharge' },
    { ...range, kind: 'recharge' },
  ],
  [
    'adminCdrsQuerySchema with the flag false',
    adminCdrsQuerySchema,
    { ...filters, unverifiedOnly: 'false', page: '2' },
    {
      ...range,
      callee: '447700900123',
      country: '牙买加',
      status: 'all',
      unverifiedOnly: false,
      page: 2,
    },
  ],
  [
    'adminCdrsQuerySchema with the flag true',
    adminCdrsQuerySchema,
    { ...range, unverifiedOnly: 'true' },
    { ...range, status: 'answered', unverifiedOnly: true, page: 1 },
  ],
  [
    'adminCdrsQuerySchema defaults',
    adminCdrsQuerySchema,
    range,
    { ...range, status: 'answered', unverifiedOnly: false, page: 1 },
  ],
  ['adminCdrCountriesQuerySchema', adminCdrCountriesQuerySchema, range, range],
  [
    'adminCdrExportRequestSchema',
    adminCdrExportRequestSchema,
    range,
    { ...range, status: 'answered', unverifiedOnly: false },
  ],
  [
    'adminMergedLedgerQuerySchema',
    adminMergedLedgerQuerySchema,
    { ...range, kind: 'credit_recharge', page: '2', pageSize: '10' },
    { ...range, kind: 'credit_recharge', page: 2, pageSize: 10 },
  ],
  [
    'adminMergedLedgerQuerySchema defaults',
    adminMergedLedgerQuerySchema,
    range,
    { ...range, page: 1, pageSize: 25 },
  ],
];

describe('query and request schemas parse their own output', () => {
  it.each(cases)('%s', (_name, schema, input, expected) => {
    const once = schema.parse(input);
    expect(once).toEqual(expected);
    expect(schema.parse(once)).toEqual(expected);
  });
});

describe('range schemas given malformed dates', () => {
  it.each(cases.map(([name, schema]) => [name, schema] as const))(
    '%s answers with a failed parse, not an exception',
    (_name, schema) => {
      for (const bad of [
        { from: 'bad', to: 'bad' },
        { from: '2026-xx-01', to: '2026-09-01' },
      ])
        expect(schema.safeParse(bad).success).toBe(false);
    },
  );
});
