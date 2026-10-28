import { z } from 'zod';
import { adminAmountRequestSchemas } from './amount-requests.js';
import {
  apiContract,
  emptyRequestSchema,
  type ApiOperation,
} from '../contract.js';
import { apiErrorSchemas } from '../errors.js';
import * as accounts from './accounts.js';
import { cdrCountriesResponseSchema } from '../cdr-fields.js';
import { csvExportResponseSchema } from '../export.js';
import * as cdrs from './cdrs.js';
import * as balance from './balance.js';
import * as auditLogs from './audit-logs.js';
import * as cdrDeletions from './cdr-deletions.js';
import * as ledger from './ledger.js';
import * as rates from './rates.js';
import * as receivables from './receivables.js';
import * as statements from './statements.js';
import { statementMonthParamsSchema } from '../statement-fields.js';
import * as tenants from './tenants.js';
import * as unassigned from './unassigned.js';
import {
  adminIdParamsSchema,
  adminMutationResponseSchema,
  adminTenantParamsSchema,
} from './common.js';
import {
  adminConflictCodeSchema,
  adminConflictErrorSchema,
  adminCsvInputErrorSchema,
  adminCsvLimitErrorSchema,
} from './errors.js';

const noBody = emptyRequestSchema.optional();
const responses = {
  400: apiErrorSchemas.VALIDATION_ERROR,
  401: z.union([
    apiErrorSchemas.UNAUTHENTICATED,
    apiErrorSchemas.SESSION_EXPIRED,
  ]),
  403: z.union([
    apiErrorSchemas.FORBIDDEN,
    apiErrorSchemas.ACCOUNT_DISABLED,
    apiErrorSchemas.IDENTITY_UNAVAILABLE,
    apiErrorSchemas.PASSWORD_CHANGE_REQUIRED,
  ]),
  404: apiErrorSchemas.NOT_FOUND,
  429: apiErrorSchemas.RATE_LIMITED,
  500: apiErrorSchemas.INTERNAL_ERROR,
  503: apiErrorSchemas.SERVICE_UNAVAILABLE,
};
const csvErrors = {
  400: z.union([apiErrorSchemas.VALIDATION_ERROR, adminCsvInputErrorSchema]),
  413: adminCsvLimitErrorSchema,
};
function conflicts<
  const Codes extends readonly [
    z.infer<typeof adminConflictCodeSchema>,
    ...z.infer<typeof adminConflictCodeSchema>[],
  ],
>(codes: Codes) {
  return {
    409: adminConflictErrorSchema.extend({
      error: adminConflictErrorSchema.shape.error.extend({
        code: adminConflictCodeSchema.extract(codes),
      }),
    }),
  };
}
const rateCommitErrors = conflicts([
  'PREVIEW_STALE',
  'PREVIEW_EXPIRED',
  'RATE_VERSION_CONFLICT',
]);
function operation<
  const Id extends string,
  const Method extends ApiOperation['method'],
  const Path extends ApiOperation['path'],
  Request extends ApiOperation['request'],
  Response extends z.ZodType,
  const Errors extends Partial<Record<number, z.ZodType>>,
>(
  operationId: Id,
  method: Method,
  path: Path,
  request: Request,
  response: Response,
  extraResponses: Errors,
) {
  return {
    operationId,
    method,
    path,
    access: 'admin',
    isolationCase: 'admin-only',
    request,
    responses: { ...responses, ...extraResponses, 200: response },
  } as const satisfies ApiOperation;
}

const tenantRequest = {
  params: adminTenantParamsSchema,
  query: emptyRequestSchema,
  body: noBody,
};
const idRequest = {
  params: adminIdParamsSchema,
  query: emptyRequestSchema,
  body: noBody,
};
const globalRequest = {
  params: emptyRequestSchema,
  query: emptyRequestSchema,
  body: noBody,
};

export function createAdminApiContract(
  rateRequests = rates.adminRateRequestSchemas,
  amountRequests = adminAmountRequestSchemas,
) {
  return {
    adminTenants: operation(
      'adminTenants',
      'GET',
      '/api/admin/tenants',
      { ...globalRequest, query: tenants.adminTenantsQuerySchema },
      tenants.adminTenantsResponseSchema,
      {},
    ),
    adminTenantCreate: operation(
      'adminTenantCreate',
      'POST',
      '/api/admin/tenants',
      { ...globalRequest, body: amountRequests.tenantCreate },
      tenants.adminTenantCreateResponseSchema,
      {
        ...csvErrors,
        ...conflicts(['TENANT_CODE_EXISTS', 'CURRENCY_MISMATCH']),
      },
    ),
    adminTenantDetail: operation(
      'adminTenantDetail',
      'GET',
      '/api/admin/tenants/{tenantId}',
      tenantRequest,
      tenants.adminTenantDetailResponseSchema,
      {},
    ),
    adminTenantEdit: operation(
      'adminTenantEdit',
      'POST',
      '/api/admin/tenants/{tenantId}/edit',
      { ...tenantRequest, body: tenants.adminTenantEditRequestSchema },
      adminMutationResponseSchema,
      {},
    ),
    adminTenantDisable: operation(
      'adminTenantDisable',
      'POST',
      '/api/admin/tenants/{tenantId}/disable',
      tenantRequest,
      adminMutationResponseSchema,
      {},
    ),
    adminTenantEnable: operation(
      'adminTenantEnable',
      'POST',
      '/api/admin/tenants/{tenantId}/enable',
      tenantRequest,
      adminMutationResponseSchema,
      {},
    ),
    adminTenantOverview: operation(
      'adminTenantOverview',
      'GET',
      '/api/admin/tenants/{tenantId}/overview',
      tenantRequest,
      tenants.adminTenantOverviewResponseSchema,
      {},
    ),
    adminTenantSettings: operation(
      'adminTenantSettings',
      'POST',
      '/api/admin/tenants/{tenantId}/settings',
      { ...tenantRequest, body: amountRequests.settings },
      adminMutationResponseSchema,
      {},
    ),
    adminTenantLedger: operation(
      'adminTenantLedger',
      'GET',
      '/api/admin/tenants/{tenantId}/ledger',
      { ...tenantRequest, query: ledger.adminLedgerQuerySchema },
      ledger.adminLedgerResponseSchema,
      {},
    ),
    adminBalanceOperation: operation(
      'adminBalanceOperation',
      'POST',
      '/api/admin/tenants/{tenantId}/balance-operations',
      { ...tenantRequest, body: amountRequests.balance },
      balance.adminBalanceOperationResponseSchema,
      conflicts(['CURRENCY_MISMATCH', 'IDEMPOTENCY_CONFLICT']),
    ),
    adminPortalAccounts: operation(
      'adminPortalAccounts',
      'GET',
      '/api/admin/tenants/{tenantId}/portal-accounts',
      tenantRequest,
      accounts.adminPortalAccountsResponseSchema,
      {},
    ),
    adminPortalAccountCreate: operation(
      'adminPortalAccountCreate',
      'POST',
      '/api/admin/tenants/{tenantId}/portal-accounts',
      {
        ...tenantRequest,
        body: accounts.adminPortalAccountCreateRequestSchema,
      },
      accounts.adminPortalAccountCreateResponseSchema,
      conflicts(['EMAIL_EXISTS', 'PORTAL_ACCOUNT_EXISTS']),
    ),
    resetPortalAccountPassword: apiContract.resetPortalAccountPassword,
    adminPortalAccountDisable: operation(
      'adminPortalAccountDisable',
      'POST',
      '/api/admin/portal-accounts/{id}/disable',
      idRequest,
      adminMutationResponseSchema,
      {},
    ),
    adminPortalAccountEnable: operation(
      'adminPortalAccountEnable',
      'POST',
      '/api/admin/portal-accounts/{id}/enable',
      idRequest,
      adminMutationResponseSchema,
      {},
    ),
    adminRates: operation(
      'adminRates',
      'GET',
      '/api/admin/tenants/{tenantId}/rates',
      { ...tenantRequest, query: rates.adminRatesQuerySchema },
      rates.adminRatesResponseSchema,
      {},
    ),
    adminRateCancelFutureVersion: operation(
      'adminRateCancelFutureVersion',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/cancel-future-version',
      {
        ...tenantRequest,
        body: rates.adminRateCancelFutureVersionRequestSchema,
      },
      rates.adminRateCancelFutureVersionResponseSchema,
      conflicts(['RATE_VERSION_CONFLICT']),
    ),
    adminRateEdit: operation(
      'adminRateEdit',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/edit-entry',
      { ...tenantRequest, body: rateRequests.editRequest },
      rates.adminRateVersionResponseSchema,
      conflicts(['RATE_VERSION_CONFLICT']),
    ),
    adminRateImportPreview: operation(
      'adminRateImportPreview',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/import/preview',
      { ...tenantRequest, body: rateRequests.importPreviewRequest },
      rates.adminRatePreviewResponseSchema,
      { ...csvErrors, ...conflicts(['RATE_VERSION_CONFLICT']) },
    ),
    adminRateImportCommit: operation(
      'adminRateImportCommit',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/import/commit',
      { ...tenantRequest, body: rates.adminRateImportCommitRequestSchema },
      rates.adminRateVersionResponseSchema,
      rateCommitErrors,
    ),
    adminRateExport: operation(
      'adminRateExport',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/export',
      { ...tenantRequest, body: rates.adminRateExportRequestSchema },
      rates.adminRateExportResponseSchema,
      {},
    ),
    adminRateCopyPreview: operation(
      'adminRateCopyPreview',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/copy/preview',
      { ...tenantRequest, body: rateRequests.copyPreviewRequest },
      rates.adminRatePreviewResponseSchema,
      conflicts(['CURRENCY_MISMATCH', 'RATE_VERSION_CONFLICT']),
    ),
    adminRateCopyCommit: operation(
      'adminRateCopyCommit',
      'POST',
      '/api/admin/tenants/{tenantId}/rates/copy/commit',
      { ...tenantRequest, body: rates.adminRateImportCommitRequestSchema },
      rates.adminRateVersionResponseSchema,
      conflicts([
        'PREVIEW_STALE',
        'PREVIEW_EXPIRED',
        'RATE_VERSION_CONFLICT',
        'CURRENCY_MISMATCH',
      ]),
    ),
    adminReceivables: operation(
      'adminReceivables',
      'GET',
      '/api/admin/receivables',
      { ...globalRequest, query: receivables.adminReceivablesQuerySchema },
      receivables.adminReceivablesResponseSchema,
      {},
    ),
    adminConfirmPayment: operation(
      'adminConfirmPayment',
      'POST',
      '/api/admin/receivables/{id}/confirm-payment',
      { ...idRequest, body: receivables.adminConfirmPaymentRequestSchema },
      receivables.adminConfirmPaymentResponseSchema,
      conflicts([
        'ALREADY_RECEIVED',
        'RECEIVABLE_VOIDED',
        'SETTLEMENT_CONFLICT',
      ]),
    ),
    adminVoidReceivable: operation(
      'adminVoidReceivable',
      'POST',
      '/api/admin/receivables/{id}/void',
      { ...idRequest, body: receivables.adminVoidReceivableRequestSchema },
      receivables.adminVoidReceivableResponseSchema,
      conflicts([
        'ALREADY_RECEIVED',
        'RECEIVABLE_VOIDED',
        'RECEIVABLE_REVERSAL_MISMATCH',
      ]),
    ),
    adminReversePayment: operation(
      'adminReversePayment',
      'POST',
      '/api/admin/receivables/{id}/reverse-payment',
      { ...idRequest, body: receivables.adminReversePaymentRequestSchema },
      receivables.adminReversePaymentResponseSchema,
      conflicts(['SETTLEMENT_CONFLICT', 'RECEIVABLE_VOIDED']),
    ),
    adminAccounts: operation(
      'adminAccounts',
      'GET',
      '/api/admin/admins',
      { ...globalRequest, query: accounts.adminAccountsQuerySchema },
      accounts.adminAccountsResponseSchema,
      {},
    ),
    adminAccountCreate: operation(
      'adminAccountCreate',
      'POST',
      '/api/admin/admins',
      { ...globalRequest, body: accounts.adminAccountCreateRequestSchema },
      accounts.adminAccountCreateResponseSchema,
      conflicts(['EMAIL_EXISTS']),
    ),
    resetAdminPassword: apiContract.resetAdminPassword,
    adminAccountEnable: operation(
      'adminAccountEnable',
      'POST',
      '/api/admin/admins/{id}/enable',
      idRequest,
      adminMutationResponseSchema,
      {},
    ),
    adminAccountDisable: operation(
      'adminAccountDisable',
      'POST',
      '/api/admin/admins/{id}/disable',
      idRequest,
      adminMutationResponseSchema,
      conflicts(['SELF_DISABLE', 'LAST_ADMIN']),
    ),
  } satisfies Record<string, ApiOperation>;
}
export const adminApiContract = createAdminApiContract();
export type AdminApiOperationId = keyof typeof adminApiContract;

/**
 * 阶段 6 后台话单操作，登记方式同 portalApiContract：后端 PR 把它并入 liveApiContract。
 * 导出是 POST，因为它写 cdr_export 操作日志（纯 GET 不承担写审计）；成功响应是流式 CSV。
 */
export const adminCdrApiContract = {
  adminTenantCdrs: operation(
    'adminTenantCdrs',
    'GET',
    '/api/admin/tenants/{tenantId}/cdrs',
    { ...tenantRequest, query: cdrs.adminCdrsQuerySchema },
    cdrs.adminCdrsResponseSchema,
    {},
  ),
  adminTenantCdrCountries: operation(
    'adminTenantCdrCountries',
    'GET',
    '/api/admin/tenants/{tenantId}/cdrs/countries',
    { ...tenantRequest, query: cdrs.adminCdrCountriesQuerySchema },
    cdrCountriesResponseSchema,
    {},
  ),
  adminTenantCdrsExport: operation(
    'adminTenantCdrsExport',
    'POST',
    '/api/admin/tenants/{tenantId}/cdrs/export',
    { ...tenantRequest, body: cdrs.adminCdrExportRequestSchema },
    csvExportResponseSchema,
    {},
  ),
} satisfies Record<string, ApiOperation>;
export type AdminCdrApiOperationId = keyof typeof adminCdrApiContract;

const statementRequest = {
  params: adminTenantParamsSchema.extend(statementMonthParamsSchema.shape),
  query: emptyRequestSchema,
  body: noBody,
};

/**
 * 阶段 7 后台月账单，登记方式同 adminCdrApiContract：后端 PR 把它并入 liveApiContract。
 * 汇总 CSV 导出是 POST（响应是流式 CSV），不写操作日志（决定 16）；重新生成写 statement_regenerate。
 * 账单只由 (租户, 月份) 定位，请求里没有账单 id。
 */
export const adminStatementApiContract = {
  adminStatements: operation(
    'adminStatements',
    'GET',
    '/api/admin/statements',
    { ...globalRequest, query: statements.adminStatementsQuerySchema },
    statements.adminStatementsResponseSchema,
    {},
  ),
  adminTenantStatements: operation(
    'adminTenantStatements',
    'GET',
    '/api/admin/tenants/{tenantId}/statements',
    tenantRequest,
    statements.adminTenantStatementsResponseSchema,
    {},
  ),
  adminTenantStatement: operation(
    'adminTenantStatement',
    'GET',
    '/api/admin/tenants/{tenantId}/statements/{month}',
    statementRequest,
    statements.adminTenantStatementResponseSchema,
    {},
  ),
  adminTenantStatementExport: operation(
    'adminTenantStatementExport',
    'POST',
    '/api/admin/tenants/{tenantId}/statements/{month}/export',
    statementRequest,
    csvExportResponseSchema,
    {},
  ),
  adminTenantStatementRegenerate: operation(
    'adminTenantStatementRegenerate',
    'POST',
    '/api/admin/tenants/{tenantId}/statements/{month}/regenerate',
    {
      ...statementRequest,
      body: statements.adminStatementRegenerateRequestSchema,
    },
    statements.adminStatementRegenerateResponseSchema,
    conflicts([
      'STATEMENT_DETAILS_DELETED',
      'STATEMENT_NOT_FINAL',
      'STATEMENT_VERSION_CONFLICT',
    ]),
  ),
} satisfies Record<string, ApiOperation>;
export type AdminStatementApiOperationId =
  keyof typeof adminStatementApiContract;

/**
 * 阶段 8 未归属话单，登记方式同 adminStatementApiContract：后端 PR 把它并入 liveApiContract。
 * 预览只读、不写日志；分配、忽略、撤销忽略各写一条操作日志（unassigned_assign / _ignore / _unignore）。
 */
export const adminUnassignedApiContract = {
  adminUnassignedSummary: operation(
    'adminUnassignedSummary',
    'GET',
    '/api/admin/unassigned-cdrs/summary',
    globalRequest,
    unassigned.adminUnassignedSummaryResponseSchema,
    {},
  ),
  adminUnassignedGroups: operation(
    'adminUnassignedGroups',
    'GET',
    '/api/admin/unassigned-cdrs/groups',
    globalRequest,
    unassigned.adminUnassignedGroupsResponseSchema,
    {},
  ),
  adminUnassignedList: operation(
    'adminUnassignedList',
    'GET',
    '/api/admin/unassigned-cdrs',
    { ...globalRequest, query: unassigned.adminUnassignedListQuerySchema },
    unassigned.adminUnassignedListResponseSchema,
    {},
  ),
  adminUnassignedAssignPreview: operation(
    'adminUnassignedAssignPreview',
    'POST',
    '/api/admin/unassigned-cdrs/assign-preview',
    { ...globalRequest, body: unassigned.adminUnassignedPreviewRequestSchema },
    unassigned.adminUnassignedPreviewResponseSchema,
    {},
  ),
  adminUnassignedAssign: operation(
    'adminUnassignedAssign',
    'POST',
    '/api/admin/unassigned-cdrs/assign',
    { ...globalRequest, body: unassigned.adminUnassignedAssignRequestSchema },
    unassigned.adminUnassignedAssignResponseSchema,
    conflicts([
      'UNASSIGNED_PREVIEW_STALE',
      'UNASSIGNED_NOTHING_TO_ASSIGN',
      'IDEMPOTENCY_CONFLICT',
    ]),
  ),
  adminUnassignedIgnore: operation(
    'adminUnassignedIgnore',
    'POST',
    '/api/admin/unassigned-cdrs/ignore',
    { ...globalRequest, body: unassigned.adminUnassignedIgnoreRequestSchema },
    unassigned.adminUnassignedResolveResponseSchema,
    {},
  ),
  adminUnassignedUnignore: operation(
    'adminUnassignedUnignore',
    'POST',
    '/api/admin/unassigned-cdrs/unignore',
    { ...globalRequest, body: unassigned.adminUnassignedUnignoreRequestSchema },
    unassigned.adminUnassignedResolveResponseSchema,
    {},
  ),
} satisfies Record<string, ApiOperation>;
export type AdminUnassignedApiOperationId =
  keyof typeof adminUnassignedApiContract;

/**
 * 阶段 8 删除话单：月份格状态是 GET，删除是 POST（每个月写一条 cdr_delete）。
 * 月份之间不原子，中途失败时 200 响应带 remaining 与 failure（见 adminCdrDeleteResponseSchema）。
 */
export const adminCdrDeletionApiContract = {
  adminTenantCdrDeletionMonths: operation(
    'adminTenantCdrDeletionMonths',
    'GET',
    '/api/admin/tenants/{tenantId}/cdr-deletions',
    { ...tenantRequest, query: cdrDeletions.adminCdrDeletionMonthsQuerySchema },
    cdrDeletions.adminCdrDeletionMonthsResponseSchema,
    {},
  ),
  adminTenantCdrDelete: operation(
    'adminTenantCdrDelete',
    'POST',
    '/api/admin/tenants/{tenantId}/cdr-deletions',
    { ...tenantRequest, body: cdrDeletions.adminCdrDeleteRequestSchema },
    cdrDeletions.adminCdrDeleteResponseSchema,
    conflicts(['CDR_MONTH_NOT_DELETABLE', 'CDR_DELETE_COUNT_CHANGED']),
  ),
} satisfies Record<string, ApiOperation>;
export type AdminCdrDeletionApiOperationId =
  keyof typeof adminCdrDeletionApiContract;

/** 阶段 8 操作日志：只读，访问日志本身不再记日志。 */
export const adminAuditLogApiContract = {
  adminAuditLogs: operation(
    'adminAuditLogs',
    'GET',
    '/api/admin/audit-logs',
    { ...globalRequest, query: auditLogs.adminAuditLogsQuerySchema },
    auditLogs.adminAuditLogsResponseSchema,
    {},
  ),
} satisfies Record<string, ApiOperation>;
export type AdminAuditLogApiOperationId = keyof typeof adminAuditLogApiContract;
