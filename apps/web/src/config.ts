import { z } from 'zod';
import {
  adminNonnegativeAmountSchema,
  type Currency,
} from '@fs-billing/shared';

/**
 * 构建时配置（Vite `VITE_*`）。配置写错时启动即失败，
 * 不静默退回默认值，以免大额确认阈值与运营预期不一致。
 */
const webEnvSchema = z.object({
  VITE_LARGE_AMOUNT_THRESHOLD_CNY:
    adminNonnegativeAmountSchema.default('10000'),
  VITE_LARGE_AMOUNT_THRESHOLD_USD: adminNonnegativeAmountSchema.default('1500'),
  /** 租户概况统计接口上线后改为 on。 */
  VITE_TENANT_OVERVIEW: z.enum(['on', 'off']).default('off'),
});

export function createWebConfig(env: Record<string, unknown>) {
  const parsed = webEnvSchema.parse(env);
  return {
    /** 赠送、赊账充值超过（不含等于）该金额时需要大额二次确认；仅前端规则。 */
    largeAmountThresholds: {
      CNY: parsed.VITE_LARGE_AMOUNT_THRESHOLD_CNY,
      USD: parsed.VITE_LARGE_AMOUNT_THRESHOLD_USD,
    } satisfies Record<Currency, string>,
    tenantOverviewEnabled: parsed.VITE_TENANT_OVERVIEW === 'on',
  };
}
export type WebConfig = ReturnType<typeof createWebConfig>;

export const webConfig = createWebConfig(import.meta.env);
