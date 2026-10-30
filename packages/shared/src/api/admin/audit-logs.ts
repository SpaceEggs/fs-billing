import { z } from 'zod';
import {
  auditActionSchema,
  auditChangeSchema,
  auditTargetKindSchema,
  type AuditAction,
} from './audit.js';
import {
  adminPageInfoSchema,
  adminPageQuerySchema,
  adminTimestampSchema,
} from './common.js';

/**
 * 操作日志页面的操作标签。设计稿的标签是中文示意、一个标签对应多个 action，所以接口用稳定的键，
 * 服务端按键展开成 action 集合；粒度（合并或拆分）是展示问题，action 集合以这里为准。
 */
export const auditLabelSchema = z.enum([
  'tenant_create',
  'tenant_edit',
  'balance',
  'rate',
  'receivable',
  'account',
  'export',
  'statement_regenerate',
  'unassigned_assign',
  'unassigned_ignore',
  'cdr_delete',
  'settings',
]);
export type AuditLabel = z.infer<typeof auditLabelSchema>;

export const auditLabelActions = {
  tenant_create: ['tenant_create'],
  tenant_edit: [
    'tenant_edit',
    'tenant_settings_update',
    'tenant_disable',
    'tenant_enable',
  ],
  balance: [
    'balance_topup',
    'balance_credit_topup',
    'balance_gift',
    'balance_adjustment',
  ],
  rate: [
    'rate_entry_edit',
    'rate_import',
    'rate_export',
    'rate_copy',
    'rate_schedule_cancel',
  ],
  receivable: [
    'receivable_confirm',
    'receivable_void',
    'receivable_payment_reverse',
  ],
  account: [
    'portal_account_create',
    'portal_account_disable',
    'portal_account_enable',
    'reset_password',
    'admin_create',
    'admin_disable',
    'admin_enable',
    'credential_bootstrap',
  ],
  export: ['cdr_export'],
  statement_regenerate: ['statement_regenerate'],
  unassigned_assign: ['unassigned_assign'],
  unassigned_ignore: ['unassigned_ignore', 'unassigned_unignore'],
  cdr_delete: ['cdr_delete'],
  settings: ['alert_settings_update'],
} as const satisfies Record<AuditLabel, readonly AuditAction[]>;

/** 页面上的中文标签（设计稿「第三批 · 运营」）。 */
export const auditLabelText = {
  tenant_create: '新建租户',
  tenant_edit: '修改租户 / 设置',
  balance: '充值 / 赠送 / 调账',
  rate: '修改费率 / 导入 / 复制',
  receivable: '收款',
  account: '账号',
  export: '导出',
  statement_regenerate: '重新生成账单',
  unassigned_assign: '归属话单',
  unassigned_ignore: '忽略话单',
  cdr_delete: '删除话单',
  settings: '修改设置',
} as const satisfies Record<AuditLabel, string>;

const labelByAction = new Map<AuditAction, AuditLabel>(
  auditLabelSchema.options.flatMap((label) =>
    auditLabelActions[label].map((action): [AuditAction, AuditLabel] => [
      action,
      label,
    ]),
  ),
);
/** 每个 action 恰属于一个标签；新增 action 忘了归类时 auditActionSchema 与这里的测试会失败。 */
export function auditLabelOf(action: AuditAction): AuditLabel {
  const label = labelByAction.get(action);
  if (!label) throw new Error(`操作 ${action} 没有对应的标签`);
  return label;
}

const dayQuery = z.iso.date();
export const adminAuditLogsQuerySchema = adminPageQuerySchema
  .extend({
    /** 北京日，含两端；默认最近 30 天（到今天为止）。 */
    from: dayQuery.optional(),
    to: dayQuery.optional(),
    adminId: z.uuid().optional(),
    label: auditLabelSchema.optional(),
    tenantId: z.uuid().optional(),
    /** 设计稿一页 50 条。 */
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .superRefine((query, context) => {
    if (query.from && query.to && query.from > query.to)
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: '结束日期不能早于开始日期',
      });
  });
export type AdminAuditLogsQuery = z.infer<typeof adminAuditLogsQuerySchema>;

export const adminAuditLogSchema = z.strictObject({
  id: z.uuid(),
  occurredAt: adminTimestampSchema,
  /** 管理员，或没有管理员的事件（auth:bootstrap 命令行）的来源标签。 */
  actor: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('admin'),
      id: z.uuid(),
      name: z.string().min(1),
    }),
    z.strictObject({ kind: z.literal('system'), label: z.string().min(1) }),
  ]),
  action: auditActionSchema,
  label: auditLabelSchema,
  tenant: z
    .strictObject({
      id: z.uuid(),
      code: z.string().min(1),
      name: z.string().min(1),
    })
    .nullable(),
  /** 对象；载荷缺失或不合规的旧记录为 null。 */
  target: z
    .strictObject({ kind: auditTargetKindSchema, id: z.uuid() })
    .nullable(),
  summary: z.string().min(1),
  /** 展开后的「字段 / 修改前 / 修改后」。 */
  changes: z.array(auditChangeSchema),
});
export type AdminAuditLog = z.infer<typeof adminAuditLogSchema>;

export const adminAuditLogsResponseSchema = z.strictObject({
  /** 实际生效的日期范围（北京日），请求没传时是默认值。 */
  range: z.strictObject({ from: dayQuery, to: dayQuery }),
  items: z.array(adminAuditLogSchema).max(100),
  pagination: adminPageInfoSchema,
});
export type AdminAuditLogsResponse = z.infer<
  typeof adminAuditLogsResponseSchema
>;
