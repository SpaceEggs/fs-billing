import { z } from 'zod';

/**
 * 租户状态：手动停用优先；其余按余额判定，见 docs/phase-5-design.md。
 * 后台与门户共用，门户不得依赖 admin 模块的 schema。
 */
export const tenantHealthSchema = z.enum([
  'suspended',
  'overdraft',
  'low_balance',
  'normal',
  'disabled',
]);
export type TenantHealth = z.infer<typeof tenantHealthSchema>;
