import { z } from 'zod';
import { currencySchema } from '../identity.js';
import { nonnegativeMoneyAmountSchema, moneyAmountSchema } from '../money.js';
import { statementMonthSchema } from '../statement-fields.js';
import {
  adminAuditedMutationResponseSchema,
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminTimestampSchema,
} from './common.js';

/**
 * 未归属话单的选择：勾选的 id，或「选择该分组全部」（标签空串表示标签为空的分组）。
 * ids 的上限只是防止异常输入；每个操作的行数上限由数据库层强制（预览与分配 500，忽略与撤销忽略 2000，
 * 超过返回 400 VALIDATION_ERROR 并提示分批），分组选择在请求时点解析，不要求客户端发全部 id。
 */
export const UNASSIGNED_SELECTION_MAX_IDS = 2000;
export const unassignedSelectionSchema = z.union([
  z.strictObject({
    ids: z.array(z.uuid()).min(1).max(UNASSIGNED_SELECTION_MAX_IDS),
  }),
  z.strictObject({ group: z.strictObject({ tag: z.string().max(200) }) }),
]);
export type UnassignedSelection = z.infer<typeof unassignedSelectionSchema>;

const tenantRefSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1),
  name: z.string().min(1),
});
const reasonCountSchema = z.strictObject({
  reason: z.string().min(1),
  count: z.int().positive(),
});

export const adminUnassignedSummaryResponseSchema = z.strictObject({
  pending: z.int().nonnegative(),
  ignored: z.int().nonnegative(),
});
export type AdminUnassignedSummaryResponse = z.infer<
  typeof adminUnassignedSummaryResponseSchema
>;

export const adminUnassignedGroupSchema = z.strictObject({
  /** 空串表示标签为空。 */
  tag: z.string(),
  count: z.int().positive(),
  reasons: z.array(reasonCountSchema).min(1),
  /** 标签与租户编码的编辑距离不超过 1（忽略大小写），「疑似拼写错误，相近：ABC001」。 */
  suggestedTenants: z.array(tenantRefSchema),
});
export const adminUnassignedGroupsResponseSchema = z.strictObject({
  /** 全部待处理条数（设计稿的「全部」）。 */
  total: z.int().nonnegative(),
  /** 按条数降序。 */
  groups: z.array(adminUnassignedGroupSchema),
});
export type AdminUnassignedGroup = z.infer<typeof adminUnassignedGroupSchema>;
export type AdminUnassignedGroupsResponse = z.infer<
  typeof adminUnassignedGroupsResponseSchema
>;

/** 待处理、已忽略；superseded 是系统自动解决（修正重推成功），不在页面页签里，但可以查。 */
export const adminUnassignedListStatusSchema = z.enum([
  'pending',
  'ignored',
  'superseded',
]);
export const adminUnassignedListQuerySchema = adminPageQuerySchema.extend({
  status: adminUnassignedListStatusSchema.default('pending'),
  /** 不传表示全部标签；传空串表示标签为空的分组。 */
  tag: z.string().max(200).optional(),
  /** 精确匹配原因（系统告警详情的跳转：告警键里的原因）。 */
  reason: z.string().min(1).max(500).optional(),
});
export type AdminUnassignedListQuery = z.infer<
  typeof adminUnassignedListQuerySchema
>;

export const adminUnassignedRowSchema = z.strictObject({
  id: z.uuid(),
  /** 校验失败的话单没有通话身份。 */
  callUuid: z.uuid().nullable(),
  /** 接通时间，未接通取开始时间；校验失败的话单两者都没有，为 null（页面取 receivedAt）。 */
  time: adminTimestampSchema.nullable(),
  receivedAt: adminTimestampSchema,
  tag: z.string(),
  caller: z.string(),
  callee: z.string(),
  durationSeconds: z.int().nonnegative(),
  reason: z.string().min(1),
  /** 没有通话身份、没有计费号码或原因不是「租户不存在 / 缺少租户标签 / 接通时无费率」的话单只能忽略。 */
  assignable: z.boolean(),
  /** 同一份无效原文被推送的次数。 */
  pushCount: z.int().positive(),
  /** 已忽略的话单：原因、操作人、时间。 */
  ignore: z
    .strictObject({
      reason: z.string(),
      by: z.strictObject({ id: z.uuid(), name: z.string().min(1) }).nullable(),
      at: adminTimestampSchema.nullable(),
    })
    .nullable(),
});
export const adminUnassignedListResponseSchema = z.strictObject({
  status: adminUnassignedListStatusSchema,
  items: z.array(adminUnassignedRowSchema).max(100),
  pagination: adminPageInfoSchema,
});
export type AdminUnassignedRow = z.infer<typeof adminUnassignedRowSchema>;
export type AdminUnassignedListResponse = z.infer<
  typeof adminUnassignedListResponseSchema
>;

export const adminUnassignedPreviewRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  selection: unassignedSelectionSchema,
});
export type AdminUnassignedPreviewRequest = z.infer<
  typeof adminUnassignedPreviewRequestSchema
>;

/** final：该月已有账单，补扣费后会过期；live：当前北京月，账单尚未生成；none：月份已结束而账单还没生成。 */
export const adminUnassignedAffectedMonthSchema = z.strictObject({
  month: statementMonthSchema,
  statementState: z.enum(['final', 'live', 'none']),
});

export const adminUnassignedPreviewResponseSchema = z.strictObject({
  tenant: z.strictObject({
    ...tenantRefSchema.shape,
    currency: currencySchema,
  }),
  /** 选中的待处理话单条数。 */
  selected: z.int().nonnegative(),
  assignable: z.int().nonnegative(),
  /** 目标租户币种，不舍入。 */
  chargeTotal: nonnegativeMoneyAmountSchema,
  currency: currencySchema,
  /** 接通时刻没有匹配费率的话单：留在待处理，只能忽略（决定 36）。 */
  noRate: z.strictObject({
    count: z.int().nonnegative(),
    groups: z.array(
      z.strictObject({
        /** before_first_version：接通早于租户第一个费率版本；prefix_not_in_version：生效版本里没有匹配的前缀。 */
        reason: z.enum(['before_first_version', 'prefix_not_in_version']),
        /** 租户任一费率版本里最长前缀匹配的条目（「前缀 1876」）。 */
        prefixHint: z
          .strictObject({
            prefix: z.string().min(1),
            country: z.string().min(1),
          })
          .nullable(),
        count: z.int().positive(),
        /** before_first_version 时租户第一个费率版本的生效时间。 */
        firstEffectiveFrom: adminTimestampSchema.nullable(),
        samples: z
          .array(
            z.strictObject({
              id: z.uuid(),
              answeredAt: adminTimestampSchema,
              billingNumber: z.string().min(1),
            }),
          )
          .max(3),
      }),
    ),
  }),
  /** 接通月份的话单已删除（决定 38），不可分配。 */
  blocked: z.strictObject({
    count: z.int().nonnegative(),
    months: z.array(statementMonthSchema),
  }),
  notAssignable: z.strictObject({
    count: z.int().nonnegative(),
    reasons: z.array(reasonCountSchema),
  }),
  balance: z.strictObject({
    current: moneyAmountSchema,
    /** 只是展示，提交时以事务内的实算为准。 */
    afterEstimate: moneyAmountSchema,
  }),
  affectedMonths: z.array(adminUnassignedAffectedMonthSchema),
});
export type AdminUnassignedPreviewResponse = z.infer<
  typeof adminUnassignedPreviewResponseSchema
>;

export const adminUnassignedAssignRequestSchema = z.strictObject({
  tenantId: z.uuid(),
  selection: unassignedSelectionSchema,
  /** 客户端幂等键，同一租户内唯一；同键重放返回原结果。 */
  idempotencyKey: z.string().trim().min(1).max(200),
  /** 预览时看到的数字；事务内实算不符则 409 UNASSIGNED_PREVIEW_STALE 并整体回滚。 */
  expected: z.strictObject({
    assignable: z.int().nonnegative(),
    noRate: z.int().nonnegative(),
    chargeTotal: nonnegativeMoneyAmountSchema,
  }),
});
export type AdminUnassignedAssignRequest = z.infer<
  typeof adminUnassignedAssignRequestSchema
>;
export const adminUnassignedAssignResponseSchema =
  adminAuditedMutationResponseSchema.extend({
    assignmentId: z.uuid(),
    /** 同键重放：返回原批次的结果，没有再次执行。 */
    replayed: z.boolean(),
    tenantId: z.uuid(),
    currency: currencySchema,
    assigned: z.int().nonnegative(),
    noRate: z.int().nonnegative(),
    blocked: z.int().nonnegative(),
    chargeTotal: nonnegativeMoneyAmountSchema,
    balanceBefore: moneyAmountSchema,
    balanceAfter: moneyAmountSchema,
    /** 补扣费落入的北京月；statementState 为 final 的月份账单会过期，页面提示前往账单页重新生成。 */
    affectedMonths: z.array(adminUnassignedAffectedMonthSchema),
  });
export type AdminUnassignedAssignResponse = z.infer<
  typeof adminUnassignedAssignResponseSchema
>;

export const adminUnassignedIgnoreRequestSchema = z.strictObject({
  selection: unassignedSelectionSchema,
  reason: z.string().trim().min(1).max(2000),
});
export type AdminUnassignedIgnoreRequest = z.infer<
  typeof adminUnassignedIgnoreRequestSchema
>;
export const adminUnassignedUnignoreRequestSchema = z.strictObject({
  selection: unassignedSelectionSchema,
});
export type AdminUnassignedUnignoreRequest = z.infer<
  typeof adminUnassignedUnignoreRequestSchema
>;
/** 实际改变状态的条数；重复提交为 0，此时不写日志、auditId 为 null。 */
export const adminUnassignedResolveResponseSchema = z.strictObject({
  changed: z.int().nonnegative(),
  auditId: z.uuid().nullable(),
});
export type AdminUnassignedResolveResponse = z.infer<
  typeof adminUnassignedResolveResponseSchema
>;
