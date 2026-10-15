import { z } from 'zod';
import { adminAmountRequestSchemas } from './amount-requests.js';
import {
  apiContract,
  emptyRequestSchema,
  type ApiOperation,
} from '../contract.js';
import { apiErrorSchemas } from '../errors.js';
import * as accounts from './accounts.js';
import * as balance from './balance.js';
import * as rates from './rates.js';
import * as receivables from './receivables.js';
import * as tenants from './tenants.js';
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
      { ...tenantRequest, query: balance.adminLedgerQuerySchema },
      balance.adminLedgerResponseSchema,
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
