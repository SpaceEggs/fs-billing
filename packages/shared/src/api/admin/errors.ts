import { z } from 'zod';
import { apiErrorStatus, apiErrorSchema } from '../errors.js';
import { adminCsvRowErrorSchema } from './rates.js';

export const adminConflictCodeSchema = z.enum([
  'TENANT_CODE_EXISTS',
  'EMAIL_EXISTS',
  'PORTAL_ACCOUNT_EXISTS',
  'CURRENCY_MISMATCH',
  'IDEMPOTENCY_CONFLICT',
  'RATE_VERSION_CONFLICT',
  'PREVIEW_STALE',
  'PREVIEW_EXPIRED',
  'ALREADY_RECEIVED',
  'RECEIVABLE_VOIDED',
  'SETTLEMENT_CONFLICT',
  'RECEIVABLE_REVERSAL_MISMATCH',
  'SELF_DISABLE',
  'LAST_ADMIN',
  'STATEMENT_DETAILS_DELETED',
  'STATEMENT_NOT_FINAL',
  'STATEMENT_VERSION_CONFLICT',
]);
const errorFields = {
  message: z.string().min(1),
  requestId: z.string().min(1),
};
export const adminConflictErrorSchema = z.strictObject({
  error: z.strictObject({ ...errorFields, code: adminConflictCodeSchema }),
});
export const adminCsvInputErrorSchema = z.strictObject({
  error: z.discriminatedUnion('code', [
    z.strictObject({
      ...errorFields,
      code: z.literal('CSV_INVALID'),
      rows: z.array(adminCsvRowErrorSchema).min(1),
    }),
    z.strictObject({
      ...errorFields,
      code: z.literal('CSV_ENCODING_UNSUPPORTED'),
    }),
  ]),
});
export const adminCsvLimitErrorSchema = z.strictObject({
  error: z.strictObject({
    ...errorFields,
    code: z.literal('CSV_LIMIT_EXCEEDED'),
  }),
});
export const adminDomainErrorSchema = z.union([
  adminConflictErrorSchema,
  adminCsvInputErrorSchema,
  adminCsvLimitErrorSchema,
]);
export const adminApiErrorSchema = z.union([
  apiErrorSchema,
  adminDomainErrorSchema,
]);
export type AdminApiError = z.infer<typeof adminApiErrorSchema>;
export type AdminApiErrorCode = AdminApiError['error']['code'];
export const adminApiErrorStatus = {
  ...apiErrorStatus,
  TENANT_CODE_EXISTS: 409,
  EMAIL_EXISTS: 409,
  PORTAL_ACCOUNT_EXISTS: 409,
  CURRENCY_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
  RATE_VERSION_CONFLICT: 409,
  PREVIEW_STALE: 409,
  PREVIEW_EXPIRED: 409,
  ALREADY_RECEIVED: 409,
  RECEIVABLE_VOIDED: 409,
  SETTLEMENT_CONFLICT: 409,
  RECEIVABLE_REVERSAL_MISMATCH: 409,
  SELF_DISABLE: 409,
  LAST_ADMIN: 409,
  STATEMENT_DETAILS_DELETED: 409,
  STATEMENT_NOT_FINAL: 409,
  STATEMENT_VERSION_CONFLICT: 409,
  CSV_INVALID: 400,
  CSV_ENCODING_UNSUPPORTED: 400,
  CSV_LIMIT_EXCEEDED: 413,
} as const satisfies Record<AdminApiErrorCode, number>;
