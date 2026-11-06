import type { QueryResultRow } from 'pg';
import {
  acceptAdminCdrExport,
  adminCdrExportCursorQuery,
  cancelPostgresBackend,
  mergedLedgerExportQuery,
  portalCdrExportCursorQuery,
  readAdminTenantStatement,
  readPortalStatement,
  type Db,
  type PoolDb,
} from '@fs-billing/db';
import {
  adminCdrExportRequestSchema,
  exportFilename,
  adminStatementApiContract,
  adminTenantParamsSchema,
  latestRangeEnd,
  statementMonthParamsSchema,
  exportLocaleRequestSchema,
  portalCdrExportRequestSchema,
  portalLedgerExportRequestSchema,
  translate,
  type Locale,
} from '@fs-billing/shared';
import type { Pool } from 'pg';
import type { RequestContext } from '../types.js';
import { ApiFailure } from '../errors.js';
import type { RouteHandlers } from './register.js';
import { adminActor } from './admin/tenants.js';
import { streamCsv } from '../export/stream-csv.js';
import {
  type StatementSummarySource,
  statementSummaryHeaders,
  statementSummaryRows,
} from '../export/statement-csv.js';
import {
  adminCdrCells,
  cdrCells,
  cdrHeaders,
  ledgerCells,
  ledgerHeaders,
  type CdrExportRow,
  type LedgerExportRow,
} from '../export/csv-labels.js';

type CdrRow = QueryResultRow & CdrExportRow;
type AdminCdrRow = CdrRow & { unverified: boolean };
type LedgerRow = QueryResultRow & LedgerExportRow;

function customerTenant(context: RequestContext) {
  if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
  return context.principal.tenantId;
}

type SummaryRow = QueryResultRow & { cells: string[] };

/**
 * 账单汇总只有几十行，算好之后仍走同一个流式响应通道（槽位、超时、断开处理一致）：
 * 游标只是把算好的行按序展开，不读任何表，所以租户或后台的会话范围照常设置。
 */
const summaryCursor = `select t.cells as cells
  from jsonb_array_elements($1::jsonb) with ordinality as t(cells, ord)
  order by t.ord`;

function streamStatementSummary({
  request,
  reply,
  pool,
  scope,
  tenantId,
  statement,
  locale,
}: {
  request: Parameters<typeof streamCsv>[0]['request'];
  reply: Parameters<typeof streamCsv>[0]['reply'];
  pool: Pool;
  scope: Parameters<typeof streamCsv>[0]['scope'];
  tenantId: string;
  statement: StatementSummarySource & {
    tenantCode: string;
    month: string;
    currency: string;
  };
  locale: Locale;
}) {
  const first = `${statement.month}-01`;
  return streamCsv<SummaryRow>({
    request,
    reply,
    pool,
    cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
    admissionTenantId: tenantId,
    scope,
    cursor: {
      text: summaryCursor,
      values: [JSON.stringify(statementSummaryRows(statement, locale))],
    },
    headers: statementSummaryHeaders(statement.currency, locale),
    prepare: (signal) => {
      signal.throwIfAborted();
      return Promise.resolve({
        filename: exportFilename('statement', statement.tenantCode, {
          from: first,
          to: latestRangeEnd(first),
        }),
      });
    },
    rowToCells: (row) => row.cells,
  });
}

export function exportHandlers({
  db,
  auditDb,
  pool,
}: {
  db: Db;
  auditDb: PoolDb;
  pool: Pool;
}): Pick<
  RouteHandlers,
  | 'portalCdrsExport'
  | 'adminTenantCdrsExport'
  | 'portalLedgerExport'
  | 'portalStatementExport'
  | 'adminTenantStatementExport'
> {
  return {
    portalStatementExport: async (context, request, reply) => {
      const tenantId = customerTenant(context);
      if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
      const { locale } = exportLocaleRequestSchema.parse(request.body ?? {});
      const statement = await readPortalStatement({
        db,
        tenantId,
        month: statementMonthParamsSchema.parse(request.params).month,
      });
      return streamStatementSummary({
        request,
        reply,
        pool,
        scope: { kind: 'tenant', tenantId },
        tenantId,
        statement: { ...statement, tenantCode: context.identity.tenant.code },
        locale,
      });
    },
    adminTenantStatementExport: async (context, request, reply) => {
      adminActor(context);
      const { locale } = exportLocaleRequestSchema.parse(request.body ?? {});
      const statement = await readAdminTenantStatement({
        db,
        ...adminStatementApiContract.adminTenantStatementExport.request.params.parse(
          request.params,
        ),
      });
      return streamStatementSummary({
        request,
        reply,
        pool,
        scope: { kind: 'admin' },
        tenantId: statement.tenant.id,
        statement: { ...statement, tenantCode: statement.tenant.code },
        locale,
      });
    },
    portalCdrsExport: (context, request, reply) => {
      const tenantId = customerTenant(context);
      if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
      const query = portalCdrExportRequestSchema.parse(request.body);
      const cursor = portalCdrExportCursorQuery({ tenantId, query });
      return streamCsv<CdrRow>({
        request,
        reply,
        pool,
        cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
        admissionTenantId: tenantId,
        scope: { kind: 'tenant', tenantId },
        cursor: { text: cursor.sql, values: cursor.params },
        headers: [
          ...cdrHeaders(query.locale),
          translate(query.locale, 'csv:cdr.headers.direction'),
        ],
        prepare: (signal) => {
          signal.throwIfAborted();
          return Promise.resolve({
            filename: exportFilename(
              'cdrs',
              context.identity.tenant.code,
              query,
            ),
          });
        },
        rowToCells: (row) => cdrCells(row, query.locale),
      });
    },
    adminTenantCdrsExport: (context, request, reply) => {
      const tenantId = adminTenantParamsSchema.parse(request.params).tenantId;
      const actor = adminActor(context);
      const query = adminCdrExportRequestSchema.parse(request.body);
      const cursor = adminCdrExportCursorQuery({ tenantId, query });
      return streamCsv<AdminCdrRow>({
        request,
        reply,
        pool,
        cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
        admissionTenantId: tenantId,
        scope: { kind: 'admin' },
        cursor: { text: cursor.sql, values: cursor.params },
        headers: [
          ...cdrHeaders(query.locale),
          translate(query.locale, 'csv:cdr.headers.verificationStatus'),
          translate(query.locale, 'csv:cdr.headers.direction'),
        ],
        prepare: (signal) =>
          acceptAdminCdrExport({
            db: auditDb,
            tenantId,
            actor,
            query,
            signal,
          }).then((accepted) => ({
            filename: exportFilename('cdrs', accepted.code, query),
          })),
        rowToCells: (row) => adminCdrCells(row, query.locale),
      });
    },
    portalLedgerExport: (context, request, reply) => {
      const tenantId = customerTenant(context);
      if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
      const query = portalLedgerExportRequestSchema.parse(request.body);
      const exportQuery = mergedLedgerExportQuery({ tenantId, query });
      return streamCsv<LedgerRow>({
        request,
        reply,
        pool,
        cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
        admissionTenantId: tenantId,
        scope: { kind: 'tenant', tenantId },
        cursor: { text: exportQuery.sql, values: exportQuery.params },
        headers: ledgerHeaders(context.identity.tenant.currency, query.locale),
        prepare: (signal) => {
          signal.throwIfAborted();
          return Promise.resolve({
            filename: exportFilename(
              'ledger',
              context.identity.tenant.code,
              query,
            ),
          });
        },
        rowToCells: (row) => ledgerCells(row, query.locale),
      });
    },
  };
}
