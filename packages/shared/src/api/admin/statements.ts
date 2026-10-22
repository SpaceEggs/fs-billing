import { z } from 'zod';
import { currencySchema } from '../identity.js';
import {
  adminStatementRegenerableSchema,
  checkStatementBreakdown,
  checkStatementFigures,
  checkStatementLiveness,
  statementCountryFields,
  statementDayFields,
  statementFigureFields,
  statementMonthSchema,
  statementPeriodFields,
  statementReconcileStatusSchema,
  statementStateSchema,
  statementTimestampSchema,
} from '../statement-fields.js';
import { moneyAmountSchema } from '../money.js';

/** 后台账单的数字：与门户同一张字段表，但是自己的 schema，门户不会因后台加字段而变。 */
export const adminStatementFiguresSchema = z
  .strictObject(statementFigureFields)
  .superRefine((figures, context) => checkStatementFigures(figures, context));
export type AdminStatementFigures = z.infer<typeof adminStatementFiguresSchema>;

/** 重新生成与审计里的前后数字：账单数字加版本。 */
export const adminStatementVersionFiguresSchema = z
  .strictObject({ ...statementFigureFields, version: z.int().min(1) })
  .superRefine((figures, context) => checkStatementFigures(figures, context));
export type AdminStatementVersionFigures = z.infer<
  typeof adminStatementVersionFiguresSchema
>;

export const adminStatementTenantSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
});

export const adminStatementsQuerySchema = z.strictObject({
  /** 默认上一个北京月。晚于当前北京月是 400。 */
  month: statementMonthSchema.optional(),
});
export type AdminStatementsQuery = z.infer<typeof adminStatementsQuerySchema>;

const rowFields = {
  month: statementMonthSchema,
  generatedAt: statementTimestampSchema.nullable(),
  /** 首次生成时间；重新生成后与 generatedAt 不同，页面显示「已重新生成 · 原 …」。 */
  firstGeneratedAt: statementTimestampSchema.nullable(),
  /** 0 表示还没有账单行。 */
  version: z.int().nonnegative(),
  detailsDeleted: z.boolean(),
  /** stale 即「账单已过期」，inconsistent 即「账单与流水不一致」；没有账单行为 null。 */
  reconcileStatus: statementReconcileStatusSchema.nullable(),
  regenerable: adminStatementRegenerableSchema,
};

function checkRowShape(
  row: {
    state: z.infer<typeof statementStateSchema>;
    version: number;
    firstGeneratedAt: string | null;
    reconcileStatus: string | null;
    generatedAt: string | null;
    detailsDeleted: boolean;
    regenerable: { allowed: boolean; reason: string | null };
  },
  context: z.RefinementCtx,
) {
  checkStatementLiveness(row, context);
  const stored = row.state === 'final';
  if (stored !== row.version >= 1 || stored !== (row.firstGeneratedAt !== null))
    context.addIssue({
      code: 'custom',
      path: ['version'],
      message: '只有已生成的账单才有版本和首次生成时间',
    });
  if (stored !== (row.reconcileStatus !== null))
    context.addIssue({
      code: 'custom',
      path: ['reconcileStatus'],
      message: '只有已生成的账单才有核对状态',
    });
  const expected =
    row.state === 'in_progress'
      ? 'in_progress'
      : row.detailsDeleted
        ? 'details_deleted'
        : null;
  if (row.regenerable.reason !== expected)
    context.addIssue({
      code: 'custom',
      path: ['regenerable', 'reason'],
      message: '不可重新生成的原因与状态不符',
    });
}

/** 租户详情「账单」标签页的一行：待生成的月份也实时算出数字。 */
export const adminTenantStatementRowSchema = z
  .strictObject({
    ...rowFields,
    state: statementStateSchema,
    figures: adminStatementFiguresSchema,
  })
  .superRefine(checkRowShape);
export type AdminTenantStatementRow = z.infer<
  typeof adminTenantStatementRowSchema
>;

export const adminTenantStatementsResponseSchema = z
  .strictObject({
    currency: currencySchema,
    tenant: adminStatementTenantSchema,
    asOf: statementTimestampSchema,
    items: z.array(adminTenantStatementRowSchema).min(1),
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
export type AdminTenantStatementsResponse = z.infer<
  typeof adminTenantStatementsResponseSchema
>;

/**
 * 后台账单页一行：应有而缺账单行的租户是 pending 且 figures 为 null（页面显示「未生成」），
 * 不为每个缺失行做实时聚合。
 */
export const adminStatementListRowSchema = z
  .strictObject({
    ...rowFields,
    tenant: adminStatementTenantSchema,
    state: z.enum(['final', 'pending']),
    figures: adminStatementFiguresSchema.nullable(),
  })
  .superRefine((row, context) => {
    checkRowShape(row, context);
    if ((row.state === 'pending') !== (row.figures === null))
      context.addIssue({
        code: 'custom',
        path: ['figures'],
        message: '只有未生成的行没有数字',
      });
  });
export type AdminStatementListRow = z.infer<typeof adminStatementListRowSchema>;

/** 一个币种一组，不跨币种相加；合计由服务端在全量行上算，只算 final 行。 */
export const adminStatementGroupSchema = z.strictObject({
  currency: currencySchema,
  tenantCount: z.int().positive(),
  totals: adminStatementFiguresSchema,
  items: z.array(adminStatementListRowSchema).min(1),
});

export const adminStatementsResponseSchema = z
  .strictObject({
    month: statementMonthSchema,
    asOf: statementTimestampSchema,
    groups: z.array(adminStatementGroupSchema),
  })
  .superRefine((response, context) => {
    response.groups.forEach((group, index) => {
      if (group.tenantCount !== group.items.length)
        context.addIssue({
          code: 'custom',
          path: ['groups', index, 'tenantCount'],
          message: '租户数必须等于行数',
        });
      group.items.forEach((item, itemIndex) => {
        if (item.month !== response.month)
          context.addIssue({
            code: 'custom',
            path: ['groups', index, 'items', itemIndex, 'month'],
            message: '行的月份必须是所选月份',
          });
      });
    });
    if (
      new Set(response.groups.map((group) => group.currency)).size !==
      response.groups.length
    )
      context.addIssue({
        code: 'custom',
        path: ['groups'],
        message: '每个币种只能有一组',
      });
  });
export type AdminStatementsResponse = z.infer<
  typeof adminStatementsResponseSchema
>;

export const adminStatementReconcileSchema = z.strictObject({
  status: statementReconcileStatusSchema,
  reconciledAt: statementTimestampSchema.nullable(),
  /** 核对出的差额：期末有差用期末差，否则用期初差；一致或未核对为 null。 */
  diff: moneyAmountSchema.nullable(),
});

export const adminTenantStatementResponseSchema = z
  .strictObject({
    currency: currencySchema,
    tenant: adminStatementTenantSchema,
    month: statementMonthSchema,
    state: statementStateSchema,
    period: z.strictObject(statementPeriodFields),
    asOf: statementTimestampSchema.nullable(),
    generatedAt: statementTimestampSchema.nullable(),
    firstGeneratedAt: statementTimestampSchema.nullable(),
    detailsDeleted: z.boolean(),
    version: z.int().nonnegative(),
    generatedBy: z
      .strictObject({ id: z.uuid(), name: z.string().min(1) })
      .nullable(),
    /** 实时月份没有账单行，没有核对结果。 */
    reconcile: adminStatementReconcileSchema.nullable(),
    /** 通话扣费 − 国家费用合计；不为零不阻止生成，也不触发流水核对告警。 */
    breakdownGap: moneyAmountSchema,
    regenerable: adminStatementRegenerableSchema,
    figures: adminStatementFiguresSchema,
    countries: z.array(z.strictObject(statementCountryFields)),
    days: z.array(z.strictObject(statementDayFields)),
  })
  .superRefine((response, context) => {
    checkStatementLiveness(response, context);
    checkStatementBreakdown(response, context);
    const stored = response.state === 'final';
    if (
      stored !== response.version >= 1 ||
      stored !== (response.reconcile !== null)
    )
      context.addIssue({
        code: 'custom',
        path: ['version'],
        message: '只有已生成的账单才有版本和核对结果',
      });
    if (stored !== (response.firstGeneratedAt !== null))
      context.addIssue({
        code: 'custom',
        path: ['firstGeneratedAt'],
        message: '只有已生成的账单才有首次生成时间',
      });
    if (!stored && response.generatedBy !== null)
      context.addIssue({
        code: 'custom',
        path: ['generatedBy'],
        message: '只有已生成的账单才有生成人',
      });
  });
export type AdminTenantStatementResponse = z.infer<
  typeof adminTenantStatementResponseSchema
>;

/**
 * expectedVersion 是对话框打开时看到的版本；月份还没有账单行（待生成）时是 0，这时等同补建。
 * 请求里没有账单 id：账单只由 (租户, 月份) 定位。
 */
export const adminStatementRegenerateRequestSchema = z.strictObject({
  expectedVersion: z.int().nonnegative(),
});
export type AdminStatementRegenerateRequest = z.infer<
  typeof adminStatementRegenerateRequestSchema
>;

export const adminStatementRegenerateResponseSchema = z
  .strictObject({
    auditId: z.uuid(),
    month: statementMonthSchema,
    /** 月份原本没有账单行，这次是补建（版本 1）。 */
    created: z.boolean(),
    /** 数字与明细都和现有账单相同时为 false：不加版本，仍写操作日志。 */
    changed: z.boolean(),
    before: adminStatementVersionFiguresSchema.nullable(),
    after: adminStatementVersionFiguresSchema,
    /** 此刻期初与账本不符的后续账单月份（升序），提示按月份顺序逐个重新生成；不级联。 */
    staleFollowingMonths: z.array(statementMonthSchema),
  })
  .superRefine((response, context) => {
    if (response.created && response.before !== null)
      context.addIssue({
        code: 'custom',
        path: ['before'],
        message: '补建没有之前的账单',
      });
    if (!response.created && response.before === null)
      context.addIssue({
        code: 'custom',
        path: ['before'],
        message: '重新生成必须有之前的账单',
      });
    if (
      !response.changed &&
      JSON.stringify(response.before) !== JSON.stringify(response.after)
    )
      context.addIssue({
        code: 'custom',
        path: ['changed'],
        message: '无变化时前后数字必须相同',
      });
  });
export type AdminStatementRegenerateResponse = z.infer<
  typeof adminStatementRegenerateResponseSchema
>;
