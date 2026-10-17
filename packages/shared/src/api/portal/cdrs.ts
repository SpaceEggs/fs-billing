import { z } from 'zod';
import { currencySchema } from '../identity.js';
import {
  CDR_PAGE_SIZE,
  cdrFields,
  cdrFilterFields,
  cdrPaginationSchema,
  cdrSummaryFields,
  checkCdrShape,
  pageNumberSchema,
} from '../cdr-fields.js';
import { checkDayRange, dayRangeFields } from '../day-range.js';

/**
 * 门户话单行。strict 且不含 unverified / billing_unverified：该字段在这里无法表示，
 * 带上它的数据解析失败，而不是被悄悄丢掉。
 */
export const portalCdrSchema = z
  .strictObject(cdrFields)
  .superRefine(checkCdrShape);
export type PortalCdr = z.infer<typeof portalCdrSchema>;

export const portalCdrsQuerySchema = z
  .strictObject({ ...cdrFilterFields, page: pageNumberSchema })
  .superRefine(checkDayRange);
export type PortalCdrsQuery = z.infer<typeof portalCdrsQuerySchema>;

export const portalCdrsResponseSchema = z
  .strictObject({
    currency: currencySchema,
    items: z.array(portalCdrSchema).max(CDR_PAGE_SIZE),
    pagination: cdrPaginationSchema,
    summary: z.strictObject(cdrSummaryFields),
  })
  .superRefine((response, context) => {
    if (response.items.length > response.pagination.total)
      context.addIssue({
        code: 'custom',
        path: ['pagination', 'total'],
        message: '总数不能小于当前页条数',
      });
  });
export type PortalCdrsResponse = z.infer<typeof portalCdrsResponseSchema>;

export const portalCdrCountriesQuerySchema = z
  .strictObject(dayRangeFields)
  .superRefine(checkDayRange);

export const portalCdrExportRequestSchema = z
  .strictObject(cdrFilterFields)
  .superRefine(checkDayRange);
export type PortalCdrExportRequest = z.infer<
  typeof portalCdrExportRequestSchema
>;
