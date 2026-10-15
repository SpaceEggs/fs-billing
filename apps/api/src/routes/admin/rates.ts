import { createAdminRatesService, type Db } from '@fs-billing/db';
import {
  adminTenantParamsSchema,
  adminRatesQuerySchema,
  adminRateRequestSchemas,
  adminRateImportCommitRequestSchema,
  adminRateExportRequestSchema,
  adminRateCancelFutureVersionRequestSchema,
} from '@fs-billing/shared';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import type { RouteHandlers } from '../register.js';
import { adminActor } from './tenants.js';

function parseRequest<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiFailure('VALIDATION_ERROR');
  return parsed.data;
}

export function rateHandlers(
  db: Db,
  options: Parameters<typeof createAdminRatesService>[0] = {},
): Pick<
  RouteHandlers,
  | 'adminRates'
  | 'adminRateEdit'
  | 'adminRateImportPreview'
  | 'adminRateImportCommit'
  | 'adminRateExport'
  | 'adminRateCopyPreview'
  | 'adminRateCopyCommit'
  | 'adminRateCancelFutureVersion'
> {
  const rateRequests = options.rateRequests ?? adminRateRequestSchemas;
  const service = createAdminRatesService({ ...options, rateRequests });
  return {
    adminRates: (context, request) => {
      adminActor(context);
      return service.getRates({
        db,
        ...parseRequest(adminTenantParamsSchema, request.params),
        query: parseRequest(adminRatesQuerySchema, request.query),
      });
    },
    adminRateEdit: (context, request) =>
      service.editRate({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(rateRequests.editRequest, request.body),
      }),
    adminRateImportPreview: (context, request) =>
      service.importPreview({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(rateRequests.importPreviewRequest, request.body),
      }),
    adminRateImportCommit: (context, request) =>
      service.importCommit({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(adminRateImportCommitRequestSchema, request.body),
      }),
    adminRateExport: (context, request) =>
      service.exportRates({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(adminRateExportRequestSchema, request.body),
      }),
    adminRateCopyPreview: (context, request) =>
      service.copyPreview({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(rateRequests.copyPreviewRequest, request.body),
      }),
    adminRateCopyCommit: (context, request) =>
      service.copyCommit({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(adminRateImportCommitRequestSchema, request.body),
      }),
    adminRateCancelFutureVersion: (context, request) =>
      service.cancelFutureVersion({
        db,
        actor: adminActor(context),
        ...parseRequest(adminTenantParamsSchema, request.params),
        request: parseRequest(
          adminRateCancelFutureVersionRequestSchema,
          request.body,
        ),
      }),
  };
}
