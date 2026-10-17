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

/** 查询串里的布尔值只接受 'true' 或 'false'，z.coerce.boolean() 会把 'false' 当成真。 */
const queryFlagSchema = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** 后台话单行：门户话单行加 unverified（计费系统授权超时期间由 FreeSWITCH 放行）。 */
export const adminCdrSchema = z
  .strictObject({ ...cdrFields, unverified: z.boolean() })
  .superRefine(checkCdrShape);
export type AdminCdr = z.infer<typeof adminCdrSchema>;

export const adminCdrsQuerySchema = z
  .strictObject({
    ...cdrFilterFields,
    unverifiedOnly: queryFlagSchema.default(false),
    page: pageNumberSchema,
  })
  .superRefine(checkDayRange);
export type AdminCdrsQuery = z.infer<typeof adminCdrsQuerySchema>;

export const adminCdrsResponseSchema = z
  .strictObject({
    currency: currencySchema,
    items: z.array(adminCdrSchema).max(CDR_PAGE_SIZE),
    pagination: cdrPaginationSchema,
    summary: z.strictObject({
      ...cdrSummaryFields,
      /** 筛选结果中未经验证的条数，用于「其中未经验证 N 条」。 */
      unverifiedCalls: z.int().nonnegative(),
    }),
  })
  .superRefine((response, context) => {
    if (response.summary.unverifiedCalls > response.pagination.total)
      context.addIssue({
        code: 'custom',
        path: ['summary', 'unverifiedCalls'],
        message: '未经验证条数不能超过总数',
      });
    if (response.items.length > response.pagination.total)
      context.addIssue({
        code: 'custom',
        path: ['pagination', 'total'],
        message: '总数不能小于当前页条数',
      });
  });
export type AdminCdrsResponse = z.infer<typeof adminCdrsResponseSchema>;

export const adminCdrCountriesQuerySchema = z
  .strictObject(dayRangeFields)
  .superRefine(checkDayRange);

/** 导出写操作日志 cdr_export，所以走 POST；筛选条件与列表一致，没有页码。 */
export const adminCdrExportRequestSchema = z
  .strictObject({
    ...cdrFilterFields,
    unverifiedOnly: z.boolean().default(false),
  })
  .superRefine(checkDayRange);
export type AdminCdrExportRequest = z.infer<typeof adminCdrExportRequestSchema>;
