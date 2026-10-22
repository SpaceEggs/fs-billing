import { z } from 'zod';
import { currencySchema } from '../identity.js';
import {
  checkStatementBreakdown,
  checkStatementFigures,
  checkStatementLiveness,
  statementCountryFields,
  statementDayFields,
  statementFigureFields,
  statementMonthSchema,
  statementPeriodFields,
  statementStateSchema,
  statementTimestampSchema,
} from '../statement-fields.js';

/**
 * 门户月账单。strict，且没有版本、生成人、核对状态、差额，也没有租户 id：
 * 这些字段在这里无法表示，带上它们的数据解析失败，而不是被悄悄丢掉。
 */
export const portalStatementFiguresSchema = z
  .strictObject(statementFigureFields)
  .superRefine((figures, context) => checkStatementFigures(figures, context));
export type PortalStatementFigures = z.infer<
  typeof portalStatementFiguresSchema
>;

/** 列表的一行。生成时间在进行中和待生成的月份为 null。 */
export const portalStatementRowSchema = z
  .strictObject({
    month: statementMonthSchema,
    state: statementStateSchema,
    figures: portalStatementFiguresSchema,
    generatedAt: statementTimestampSchema.nullable(),
    detailsDeleted: z.boolean(),
  })
  .superRefine(checkStatementLiveness);
export type PortalStatementRow = z.infer<typeof portalStatementRowSchema>;

/**
 * 列表：按月份降序，含进行中月份（租户存在即有这一行，可以全零）。不分页。
 * 「还没有账单」空状态由页面判断：没有 final 行，且进行中行 calls 为 0、五个金额全 0。
 */
export const portalStatementsResponseSchema = z
  .strictObject({
    currency: currencySchema,
    items: z.array(portalStatementRowSchema).min(1),
    asOf: statementTimestampSchema,
  })
  .superRefine((response, context) => {
    response.items.forEach((item, index) => {
      const previous = response.items[index - 1];
      if (previous && previous.month <= item.month)
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'month'],
          message: '月份必须降序且不重复',
        });
    });
  });
export type PortalStatementsResponse = z.infer<
  typeof portalStatementsResponseSchema
>;

export const portalStatementCountrySchema = z.strictObject(
  statementCountryFields,
);
export const portalStatementDaySchema = z.strictObject(statementDayFields);

/** 详情。国家按费用降序，日期升序且只含有通话的日子；没有通话的日子由页面补零。 */
export const portalStatementResponseSchema = z
  .strictObject({
    currency: currencySchema,
    tenant: z.strictObject({
      code: z.string().min(1),
      name: z.string().min(1),
    }),
    month: statementMonthSchema,
    state: statementStateSchema,
    period: z.strictObject(statementPeriodFields),
    /** 实时月份（进行中、待生成）的读取时刻；已生成的账单为 null。 */
    asOf: statementTimestampSchema.nullable(),
    generatedAt: statementTimestampSchema.nullable(),
    /** 该月话单明细已被删除：账单不变，页面置灰「导出话单明细」。 */
    detailsDeleted: z.boolean(),
    figures: portalStatementFiguresSchema,
    countries: z.array(portalStatementCountrySchema),
    days: z.array(portalStatementDaySchema),
  })
  .superRefine((response, context) => {
    checkStatementLiveness(response, context);
    checkStatementBreakdown(response, context);
  });
export type PortalStatementResponse = z.infer<
  typeof portalStatementResponseSchema
>;
