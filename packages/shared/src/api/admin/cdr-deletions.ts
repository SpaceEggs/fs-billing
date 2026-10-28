import { z } from 'zod';
import { statementMonthSchema } from '../statement-fields.js';
import { adminTimestampSchema } from './common.js';

/**
 * 删除话单的月份状态（阶段 8「月份可选规则」）：
 * deletable 可删除；deleted 已删除；no_statement 月份已结束而没有账单行，或是当前月；
 * before_opening 早于第一个应有账单的月份；future 晚于当前北京月；
 * blocked 有账单但核对不是 ok，或有话单尚未扣费（原因见 blockedReasons）。
 */
export const cdrDeletionMonthStateSchema = z.enum([
  'deletable',
  'deleted',
  'no_statement',
  'before_opening',
  'future',
  'blocked',
]);
export const cdrDeletionBlockedReasonSchema = z.enum([
  'reconcile_not_ok',
  'uncharged_calls',
]);

export const adminCdrDeletionMonthsQuerySchema = z.strictObject({
  year: z.coerce.number().int().min(1).max(9999),
});
export type AdminCdrDeletionMonthsQuery = z.infer<
  typeof adminCdrDeletionMonthsQuerySchema
>;

export const adminCdrDeletionMonthSchema = z.strictObject({
  month: statementMonthSchema,
  state: cdrDeletionMonthStateSchema,
  /**
   * deletable / blocked：该月话单条数（与话单列表同一个月份谓词，含未接通话单）；
   * deleted：删除时记录的条数，旧标志没有元数据时为 null；其他状态为 null。
   */
  cdrCount: z.int().nonnegative().nullable(),
  blockedReasons: z.array(cdrDeletionBlockedReasonSchema),
  statementId: z.uuid().nullable(),
  /** 仅 deleted：谁在什么时候删除；旧标志没有元数据时 at、by 为 null。 */
  deleted: z
    .strictObject({
      at: adminTimestampSchema.nullable(),
      by: z.strictObject({ id: z.uuid(), name: z.string().min(1) }).nullable(),
    })
    .nullable(),
});
export type AdminCdrDeletionMonth = z.infer<typeof adminCdrDeletionMonthSchema>;

export const adminCdrDeletionMonthsResponseSchema = z.strictObject({
  tenant: z.strictObject({
    id: z.uuid(),
    code: z.string().min(1),
    name: z.string().min(1),
  }),
  year: z.int().min(1).max(9999),
  months: z.array(adminCdrDeletionMonthSchema).length(12),
});
export type AdminCdrDeletionMonthsResponse = z.infer<
  typeof adminCdrDeletionMonthsResponseSchema
>;

export const adminCdrDeleteRequestSchema = z.strictObject({
  fromMonth: statementMonthSchema,
  toMonth: statementMonthSchema,
  /** 二次确认：必须与租户编码完全相等（区分大小写），否则 400。 */
  tenantCode: z.string().min(1).max(100),
  /** 预览时看到的、范围内全部月份的话单条数之和；不符 409 CDR_DELETE_COUNT_CHANGED。 */
  expectedCount: z.int().nonnegative(),
});
export type AdminCdrDeleteRequest = z.infer<typeof adminCdrDeleteRequestSchema>;

export const adminCdrDeleteResponseSchema = z
  .strictObject({
    /** 已删除的月份（升序），每月一条 cdr_delete 操作日志。 */
    months: z
      .array(
        z.strictObject({
          month: statementMonthSchema,
          deleted: z.int().nonnegative(),
          statementId: z.uuid(),
          auditId: z.uuid(),
        }),
      )
      .min(1),
    total: z.int().nonnegative(),
    /** 没有处理的月份：月份之间不原子，中途失败时已完成的保留，重试只处理这些。 */
    remaining: z.array(statementMonthSchema),
    /** 中途失败（第一个月就失败时整个请求返回错误）；全部成功为 null。message 不含内部细节。 */
    failure: z
      .strictObject({
        month: statementMonthSchema,
        code: z.enum([
          'CDR_MONTH_NOT_DELETABLE',
          'CDR_DELETE_COUNT_CHANGED',
          'VALIDATION_ERROR',
          'INTERNAL',
        ]),
        message: z.string().min(1),
      })
      .nullable(),
  })
  .superRefine((response, context) => {
    if ((response.failure === null) !== (response.remaining.length === 0))
      context.addIssue({
        code: 'custom',
        path: ['remaining'],
        message: '有失败才有未处理的月份',
      });
    if (response.failure && response.remaining[0] !== response.failure.month)
      context.addIssue({
        code: 'custom',
        path: ['failure', 'month'],
        message: '失败的月份是第一个未处理的月份',
      });
  });
export type AdminCdrDeleteResponse = z.infer<
  typeof adminCdrDeleteResponseSchema
>;
