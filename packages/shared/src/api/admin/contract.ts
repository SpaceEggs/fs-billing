import { z } from 'zod';
import {
  resetPasswordParamsSchema,
  resetPasswordResponseSchema,
} from '../auth.js';
import { emptyRequestSchema, type ApiOperation } from '../contract.js';
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
  adminConflictErrorSchema,
  adminCsvInputErrorSchema,
  adminCsvLimitErrorSchema,
} from './errors.js';

const noBody = emptyRequestSchema.optional();
const responses = {
  400: z.union([apiErrorSchemas.VALIDATION_ERROR, adminCsvInputErrorSchema]),
  401: z.union([
    apiErrorSchemas.UNAUTHENTICATED,
    apiErrorSchemas.SESSION_EXPIRED,
  ]),
  403: z.union([
    apiErrorSchemas.FORBIDDEN,
    apiErrorSchemas.ACCOUNT_DISABLED,
    apiErrorSchemas.IDENTITY_UNAVAILABLE,
  ]),
  404: apiErrorSchemas.NOT_FOUND,
  409: adminConflictErrorSchema,
  413: adminCsvLimitErrorSchema,
  429: apiErrorSchemas.RATE_LIMITED,
  500: apiErrorSchemas.INTERNAL_ERROR,
  503: apiErrorSchemas.SERVICE_UNAVAILABLE,
};
function operation(
  operationId: string,
  method: ApiOperation['method'],
  path: ApiOperation['path'],
  request: ApiOperation['request'],
  response: z.ZodType,
) {
  return {
    operationId,
    method,
    path,
    access: 'admin',
    isolationCase: 'admin-only',
    request,
    responses: { ...responses, 200: response },
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

export const adminApiContract = {
  adminTenants: operation(
    'adminTenants',
    'GET',
    '/api/admin/tenants',
    { ...globalRequest, query: tenants.adminTenantsQuerySchema },
    tenants.adminTenantsResponseSchema,
  ),
  adminTenantCreate: operation(
    'adminTenantCreate',
    'POST',
    '/api/admin/tenants',
    { ...globalRequest, body: tenants.adminTenantCreateRequestSchema },
    tenants.adminTenantCreateResponseSchema,
  ),
  adminTenantDetail: operation(
    'adminTenantDetail',
    'GET',
    '/api/admin/tenants/{tenantId}',
    tenantRequest,
    tenants.adminTenantDetailResponseSchema,
  ),
  adminTenantEdit: operation(
    'adminTenantEdit',
    'POST',
    '/api/admin/tenants/{tenantId}/edit',
    { ...tenantRequest, body: tenants.adminTenantEditRequestSchema },
    adminMutationResponseSchema,
  ),
  adminTenantDisable: operation(
    'adminTenantDisable',
    'POST',
    '/api/admin/tenants/{tenantId}/disable',
    tenantRequest,
    adminMutationResponseSchema,
  ),
  adminTenantEnable: operation(
    'adminTenantEnable',
    'POST',
    '/api/admin/tenants/{tenantId}/enable',
    tenantRequest,
    adminMutationResponseSchema,
  ),
  adminTenantOverview: operation(
    'adminTenantOverview',
    'GET',
    '/api/admin/tenants/{tenantId}/overview',
    tenantRequest,
    tenants.adminTenantOverviewResponseSchema,
  ),
  adminTenantSettings: operation(
    'adminTenantSettings',
    'POST',
    '/api/admin/tenants/{tenantId}/settings',
    { ...tenantRequest, body: tenants.adminTenantSettingsSchema },
    adminMutationResponseSchema,
  ),
  adminTenantLedger: operation(
    'adminTenantLedger',
    'GET',
    '/api/admin/tenants/{tenantId}/ledger',
    { ...tenantRequest, query: balance.adminLedgerQuerySchema },
    balance.adminLedgerResponseSchema,
  ),
  adminBalanceOperation: operation(
    'adminBalanceOperation',
    'POST',
    '/api/admin/tenants/{tenantId}/balance-operations',
    { ...tenantRequest, body: balance.adminBalanceOperationRequestSchema },
    balance.adminBalanceOperationResponseSchema,
  ),
  adminPortalAccounts: operation(
    'adminPortalAccounts',
    'GET',
    '/api/admin/tenants/{tenantId}/portal-accounts',
    tenantRequest,
    accounts.adminPortalAccountsResponseSchema,
  ),
  adminPortalAccountCreate: operation(
    'adminPortalAccountCreate',
    'POST',
    '/api/admin/tenants/{tenantId}/portal-accounts',
    { ...tenantRequest, body: accounts.adminPortalAccountCreateRequestSchema },
    accounts.adminPortalAccountCreateResponseSchema,
  ),
  resetPortalAccountPassword: operation(
    'resetPortalAccountPassword',
    'POST',
    '/api/admin/portal-accounts/{id}/reset-password',
    { ...idRequest, params: resetPasswordParamsSchema },
    resetPasswordResponseSchema,
  ),
  adminRates: operation(
    'adminRates',
    'GET',
    '/api/admin/tenants/{tenantId}/rates',
    { ...tenantRequest, query: rates.adminRatesQuerySchema },
    rates.adminRatesResponseSchema,
  ),
  adminRateEdit: operation(
    'adminRateEdit',
    'POST',
    '/api/admin/tenants/{tenantId}/rates/edit-entry',
    { ...tenantRequest, body: rates.adminRateEditRequestSchema },
    rates.adminRateVersionResponseSchema,
  ),
  adminRateImportPreview: operation(
    'adminRateImportPreview',
    'POST',
    '/api/admin/tenants/{tenantId}/rates/import/preview',
    { ...tenantRequest, body: rates.adminRateImportPreviewRequestSchema },
    rates.adminRatePreviewResponseSchema,
  ),
  adminRateImportCommit: operation(
    'adminRateImportCommit',
    'POST',
    '/api/admin/tenants/{tenantId}/rates/import/commit',
    { ...tenantRequest, body: rates.adminRateImportCommitRequestSchema },
    rates.adminRateVersionResponseSchema,
  ),
  adminRateExport: operation(
    'adminRateExport',
    'GET',
    '/api/admin/tenants/{tenantId}/rates/export',
    { ...tenantRequest, query: rates.adminRateExportQuerySchema },
    rates.adminRateExportResponseSchema,
  ),
  adminRateCopyPreview: operation(
    'adminRateCopyPreview',
    'POST',
    '/api/admin/tenants/{tenantId}/rates/copy/preview',
    { ...tenantRequest, body: rates.adminRateCopyPreviewRequestSchema },
    rates.adminRatePreviewResponseSchema,
  ),
  adminRateCopyCommit: operation(
    'adminRateCopyCommit',
    'POST',
    '/api/admin/tenants/{tenantId}/rates/copy/commit',
    { ...tenantRequest, body: rates.adminRateImportCommitRequestSchema },
    rates.adminRateVersionResponseSchema,
  ),
  adminReceivables: operation(
    'adminReceivables',
    'GET',
    '/api/admin/receivables',
    { ...globalRequest, query: receivables.adminReceivablesQuerySchema },
    receivables.adminReceivablesResponseSchema,
  ),
  adminConfirmPayment: operation(
    'adminConfirmPayment',
    'POST',
    '/api/admin/receivables/{id}/confirm-payment',
    { ...idRequest, body: receivables.adminConfirmPaymentRequestSchema },
    receivables.adminConfirmPaymentResponseSchema,
  ),
  adminAccounts: operation(
    'adminAccounts',
    'GET',
    '/api/admin/admins',
    { ...globalRequest, query: accounts.adminAccountsQuerySchema },
    accounts.adminAccountsResponseSchema,
  ),
  adminAccountCreate: operation(
    'adminAccountCreate',
    'POST',
    '/api/admin/admins',
    { ...globalRequest, body: accounts.adminAccountCreateRequestSchema },
    accounts.adminAccountCreateResponseSchema,
  ),
  resetAdminPassword: operation(
    'resetAdminPassword',
    'POST',
    '/api/admin/admins/{id}/reset-password',
    { ...idRequest, params: resetPasswordParamsSchema },
    resetPasswordResponseSchema,
  ),
  adminAccountDisable: operation(
    'adminAccountDisable',
    'POST',
    '/api/admin/admins/{id}/disable',
    idRequest,
    adminMutationResponseSchema,
  ),
} satisfies Record<string, ApiOperation>;
export type AdminApiOperationId = keyof typeof adminApiContract;
