import type { QueryResultRow } from 'pg';
import {
  acceptAdminCdrExport,
  adminCdrExportCursorQuery,
  cancelPostgresBackend,
  mergedLedgerExportQuery,
  portalCdrExportCursorQuery,
  type PoolDb,
} from '@fs-billing/db';
import {
  adminCdrExportRequestSchema,
  exportFilename,
  formatHangupCause,
  formatMergedChargeNote,
  adminTenantParamsSchema,
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

const cdrHeaders = [
  '接通时间',
  '主叫号码',
  '被叫号码',
  '国家/备注',
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

export function exportHandlers({
  auditDb,
  pool,
}: {
  auditDb: PoolDb;
  pool: Pool;
}): Pick<
  RouteHandlers,
  'portalCdrsExport' | 'adminTenantCdrsExport' | 'portalLedgerExport'
> {
  return {
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
          row.country ?? '未接通',
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
          row.country ?? '未接通',
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
