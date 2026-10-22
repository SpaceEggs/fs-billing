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
  formatHangupCause,
  formatMergedChargeNote,
  adminStatementApiContract,
  adminTenantParamsSchema,
  latestRangeEnd,
  statementMonthParamsSchema,
  portalCdrExportRequestSchema,
  portalLedgerExportRequestSchema,
  type PortalLedgerRow,
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

const cdrHeaders = [
  '接通时间',
  '主叫号码',
  '被叫号码',
  'ISO',
  '国家',
  '说明',
  '通话时长(秒)',
  '计费时长(分钟)',
  '费率',
  '费用',
  '振铃开始时间',
  '挂断时间',
  '挂断原因',
  '匹配前缀',
  '通话UUID',
] as const;

type CdrExportRow = QueryResultRow & {
  callUuid: string;
  calledAt: string;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string;
  caller: string;
  callee: string;
  country: string | null;
  iso: string | null;
  description: string | null;
  durationSeconds: number;
  billedMinutes: string;
  rate: string | null;
  charge: string;
  hangupCause: string;
  matchedPrefix: string | null;
};

type AdminCdrExportRow = CdrExportRow & {
  unverified: boolean;
};

type LedgerExportRow = QueryResultRow & {
  kind: PortalLedgerRow['kind'];
  day: string;
  calls: number;
  partial: boolean;
  occurredAt: string;
  amount: string;
  balanceAfter: string;
  note: string;
};

function customerTenant(context: RequestContext) {
  if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
  return context.principal.tenantId;
}

function ledgerCells(row: LedgerExportRow): readonly string[] {
  let kind: string;
  let note = row.note;
  switch (row.kind) {
    case 'recharge':
      kind = '充值';
      break;
    case 'gift':
      kind = '赠送';
      break;
    case 'adjustment':
      kind = '调账';
      break;
    case 'call_charge':
      kind = '通话扣费';
      note = formatMergedChargeNote({
        day: row.day,
        calls: row.calls,
        partial: row.partial,
      });
      break;
    default: {
      const exhaustive: never = row.kind;
      return exhaustive;
    }
  }
  return [row.occurredAt, kind, row.amount, row.balanceAfter, note];
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
      values: [JSON.stringify(statementSummaryRows(statement))],
    },
    headers: statementSummaryHeaders(statement.currency),
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
      });
    },
    adminTenantStatementExport: async (context, request, reply) => {
      adminActor(context);
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
      });
    },
    portalCdrsExport: (context, request, reply) => {
      const tenantId = customerTenant(context);
      if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
      const query = portalCdrExportRequestSchema.parse(request.body);
      const cursor = portalCdrExportCursorQuery({ tenantId, query });
      return streamCsv<CdrExportRow>({
        request,
        reply,
        pool,
        cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
        admissionTenantId: tenantId,
        scope: { kind: 'tenant', tenantId },
        cursor: { text: cursor.sql, values: cursor.params },
        headers: cdrHeaders,
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
        rowToCells: (row) => [
          row.calledAt,
          row.caller,
          row.callee,
          row.iso ?? '',
          row.country ?? '未接通',
          row.description ?? '',
          String(row.durationSeconds),
          row.billedMinutes,
          row.rate ?? '',
          row.charge,
          row.startedAt,
          row.endedAt,
          formatHangupCause(row.hangupCause),
          row.matchedPrefix ?? '',
          row.callUuid,
        ],
      });
    },
    adminTenantCdrsExport: (context, request, reply) => {
      const tenantId = adminTenantParamsSchema.parse(request.params).tenantId;
      const actor = adminActor(context);
      const query = adminCdrExportRequestSchema.parse(request.body);
      const cursor = adminCdrExportCursorQuery({ tenantId, query });
      return streamCsv<AdminCdrExportRow>({
        request,
        reply,
        pool,
        cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
        admissionTenantId: tenantId,
        scope: { kind: 'admin' },
        cursor: { text: cursor.sql, values: cursor.params },
        headers: [...cdrHeaders, '验证状态'],
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
        rowToCells: (row) => [
          row.calledAt,
          row.caller,
          row.callee,
          row.iso ?? '',
          row.country ?? '未接通',
          row.description ?? '',
          String(row.durationSeconds),
          row.billedMinutes,
          row.rate ?? '',
          row.charge,
          row.startedAt,
          row.endedAt,
          formatHangupCause(row.hangupCause),
          row.matchedPrefix ?? '',
          row.callUuid,
          row.unverified ? '未经验证' : '',
        ],
      });
    },
    portalLedgerExport: (context, request, reply) => {
      const tenantId = customerTenant(context);
      if (context.kind !== 'customer') throw new ApiFailure('FORBIDDEN');
      const query = portalLedgerExportRequestSchema.parse(request.body);
      const exportQuery = mergedLedgerExportQuery({ tenantId, query });
      return streamCsv<LedgerExportRow>({
        request,
        reply,
        pool,
        cancelBackend: (backendPid) => cancelPostgresBackend(pool, backendPid),
        admissionTenantId: tenantId,
        scope: { kind: 'tenant', tenantId },
        cursor: { text: exportQuery.sql, values: exportQuery.params },
        headers: [
          '时间',
          '类型',
          `金额（${context.identity.tenant.currency}）`,
          `变动后余额（${context.identity.tenant.currency}）`,
          '备注',
        ],
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
        rowToCells: ledgerCells,
      });
    },
  };
}
