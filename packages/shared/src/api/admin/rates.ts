import { z } from 'zod';
import { currencySchema } from '../identity.js';
import {
  adminAuditedMutationResponseSchema,
  adminTimestampSchema,
} from './common.js';

export const adminRateAmountSchema = z
  .string()
  .max(128)
  .regex(/^\d+(?:\.\d{1,4})?$/);
export const adminRateEntrySchema = z.strictObject({
  prefix: z
    .string()
    .regex(/^\d+$/)
    .refine((value) => !value.startsWith('00'), {
      message: '前缀不能包含国际冠字 00',
    }),
  iso: z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z]{2})?$/, 'ISO 必须是两位字母，或留空')
    .toUpperCase(),
  description: z
    .string()
    .refine((value) => !/[\r\n]/.test(value), { message: '说明不能包含换行' })
    .pipe(z.string().trim().max(200)),
  country: z
    .string()
    .refine((value) => !/[\r\n]/.test(value), {
      message: '国家不能包含换行',
    })
    .pipe(z.string().trim().min(1).max(200)),
  rate: adminRateAmountSchema,
});
export const DEFAULT_ADMIN_CSV_MAX_BYTES = 2 * 1024 * 1024;
export const adminCsvBase64Length = (maxBytes: number) =>
  4 * Math.ceil(maxBytes / 3);
export const DEFAULT_ADMIN_CSV_MAX_BASE64_CHARS = adminCsvBase64Length(
  DEFAULT_ADMIN_CSV_MAX_BYTES,
);
export const DEFAULT_ADMIN_CSV_BODY_LIMIT =
  DEFAULT_ADMIN_CSV_MAX_BASE64_CHARS + 256 * 1024;
export const DEFAULT_ADMIN_RATE_MAX_ROWS = 10000;
export const DEFAULT_ADMIN_RATE_PREVIEW_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;
export const DEFAULT_ADMIN_RATE_CANCEL_CLOCK_SKEW_MARGIN_SECONDS = 60;

export function createAdminRateEntriesSchema(
  maxRows = DEFAULT_ADMIN_RATE_MAX_ROWS,
) {
  const limit = z.number().int().positive().parse(maxRows);
  return z
    .array(adminRateEntrySchema)
    .max(limit)
    .refine(
      (entries) =>
        new Set(entries.map((entry) => entry.prefix)).size === entries.length,
      { message: '前缀不能重复' },
    );
}
export const adminRateEntriesSchema = createAdminRateEntriesSchema();
export const adminRateEntriesResponseSchema = z.array(adminRateEntrySchema);
export const adminRateScheduleShapeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('immediate') }),
  z.strictObject({
    kind: z.literal('scheduled'),
    effectiveFrom: adminTimestampSchema,
  }),
]);
export function createAdminRateScheduleSchema(
  horizonMs = DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
) {
  const limit = z.number().int().positive().parse(horizonMs);
  return z.discriminatedUnion('kind', [
    adminRateScheduleShapeSchema.options[0],
    adminRateScheduleShapeSchema.options[1].extend({
      effectiveFrom:
        adminRateScheduleShapeSchema.options[1].shape.effectiveFrom.refine(
          (value) => {
            const now = Date.now();
            const effectiveFrom = Date.parse(value);
            return effectiveFrom >= now && effectiveFrom <= now + limit;
          },
          { message: '指定生效时间必须在当前时间至配置的排期上限之间' },
        ),
    }),
  ]);
}
export const adminRateVersionSchema = z.strictObject({
  id: z.uuid(),
  effectiveFrom: adminTimestampSchema,
  entries: adminRateEntriesResponseSchema,
});
export const adminRatesQuerySchema = z.strictObject({
  search: z.string().max(200).optional(),
});
export const adminRatesResponseSchema = z.strictObject({
  currency: currencySchema,
  current: adminRateVersionSchema,
  scheduled: z.array(adminRateVersionSchema),
});

export const adminRateVersionResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    version: adminRateVersionSchema,
  });
export function createAdminCsvFileSchema(
  maxBytes = DEFAULT_ADMIN_CSV_MAX_BYTES,
) {
  const limit = z.number().int().positive().parse(maxBytes);
  return z.strictObject({
    filename: z.string().min(1).max(255),
    contentBase64: z
      .string()
      .min(4)
      .max(adminCsvBase64Length(limit))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .refine(
        (value) => {
          const padding = value.endsWith('==')
            ? 2
            : value.endsWith('=')
              ? 1
              : 0;
          return (value.length / 4) * 3 - padding <= limit;
        },
        { message: 'CSV 解码字节超限' },
      ),
  });
}
export const adminCsvFileSchema = createAdminCsvFileSchema();
export const adminRateCancelFutureVersionRequestSchema = z.strictObject({
  versionId: z.uuid(),
});
export const adminRateCancelFutureVersionResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    cancelledVersionId: z.uuid(),
  });
export const adminCsvRowErrorSchema = z.strictObject({
  line: z.number().int().positive(),
  reason: z.string().min(1),
});
export const adminRateChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('added'), after: adminRateEntrySchema }),
  z.strictObject({
    kind: z.literal('modified'),
    before: adminRateEntrySchema,
    after: adminRateEntrySchema,
  }),
  z.strictObject({ kind: z.literal('deleted'), before: adminRateEntrySchema }),
]);

export const adminRatePreviewResponseSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(false),
    errors: z.array(adminCsvRowErrorSchema).min(1),
  }),
  z
    .strictObject({
      ok: z.literal(true),
      previewId: z.uuid(),
      expiresAt: adminTimestampSchema,
      currency: currencySchema,
      encoding: z.enum(['UTF-8', 'GBK']),
      counts: z.strictObject({
        added: z.number().int().nonnegative(),
        modified: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
      }),
      changes: z.array(adminRateChangeSchema),
    })
    .refine(
      (preview) =>
        preview.counts.added ===
          preview.changes.filter((change) => change.kind === 'added').length &&
        preview.counts.modified ===
          preview.changes.filter((change) => change.kind === 'modified')
            .length &&
        preview.counts.deleted ===
          preview.changes.filter((change) => change.kind === 'deleted').length,
      { message: '预览计数必须与变更一致' },
    ),
]);
export const adminRateImportCommitRequestSchema = z.strictObject({
  previewId: z.uuid(),
});
export const adminRateExportRequestSchema = z.strictObject({
  versionId: z.uuid(),
});
export const adminRateExportResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    filename: z.string().min(1),
    encoding: z.literal('UTF-8'),
    contentType: z.literal('text/csv'),
    csv: z.string(),
  });

export function createAdminRateRequestSchemas(
  horizonMs = DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
) {
  const schedule = createAdminRateScheduleSchema(horizonMs);
  const adminRateEditRequestSchema = z.strictObject({
    baseVersionId: z.uuid(),
    entry: adminRateEntrySchema,
    schedule,
  });
  const adminRateImportPreviewRequestSchema = z.strictObject({
    file: adminCsvFileSchema,
    baseVersionId: z.uuid(),
    schedule,
  });
  const adminRateCopyPreviewRequestSchema = z.strictObject({
    sourceVersionId: z.uuid(),
    targetTenantId: z.uuid(),
    targetBaseVersionId: z.uuid(),
    schedule,
  });
  return {
    schedule,
    editRequest: adminRateEditRequestSchema,
    importPreviewRequest: adminRateImportPreviewRequestSchema,
    copyPreviewRequest: adminRateCopyPreviewRequestSchema,
  };
}
export const adminRateRequestSchemas = createAdminRateRequestSchemas();
export const adminRateScheduleSchema = adminRateRequestSchemas.schedule;
export const adminRateEditRequestSchema = adminRateRequestSchemas.editRequest;
export const adminRateImportPreviewRequestSchema =
  adminRateRequestSchemas.importPreviewRequest;
export const adminRateCopyPreviewRequestSchema =
  adminRateRequestSchemas.copyPreviewRequest;

export type AdminRateAmount = z.infer<typeof adminRateAmountSchema>;
export type AdminRateEntry = z.infer<typeof adminRateEntrySchema>;
export type AdminRateEntries = z.infer<typeof adminRateEntriesSchema>;
export type AdminRateSchedule = z.infer<typeof adminRateScheduleSchema>;
export type AdminRateVersion = z.infer<typeof adminRateVersionSchema>;
export type AdminRatesQuery = z.infer<typeof adminRatesQuerySchema>;
export type AdminRatesResponse = z.infer<typeof adminRatesResponseSchema>;
export type AdminRateEditRequest = z.infer<typeof adminRateEditRequestSchema>;
export type AdminRateVersionResponse = z.infer<
  typeof adminRateVersionResponseSchema
>;
export type AdminCsvFile = z.infer<typeof adminCsvFileSchema>;
export type AdminCsvRowError = z.infer<typeof adminCsvRowErrorSchema>;
export type AdminRateChange = z.infer<typeof adminRateChangeSchema>;
export type AdminRateImportPreviewRequest = z.infer<
  typeof adminRateImportPreviewRequestSchema
>;
export type AdminRatePreviewResponse = z.infer<
  typeof adminRatePreviewResponseSchema
>;
export type AdminRateImportCommitRequest = z.infer<
  typeof adminRateImportCommitRequestSchema
>;
export type AdminRateExportRequest = z.infer<
  typeof adminRateExportRequestSchema
>;
export type AdminRateExportResponse = z.infer<
  typeof adminRateExportResponseSchema
>;
export type AdminRateCopyPreviewRequest = z.infer<
  typeof adminRateCopyPreviewRequestSchema
>;

export type AdminRateCancelFutureVersionRequest = z.infer<
  typeof adminRateCancelFutureVersionRequestSchema
>;
export type AdminRateCancelFutureVersionResponse = z.infer<
  typeof adminRateCancelFutureVersionResponseSchema
>;
