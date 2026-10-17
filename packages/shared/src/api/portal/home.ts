import { z } from 'zod';
import { currencySchema } from '../identity.js';
import { moneyAmountSchema, nonnegativeMoneyAmountSchema } from '../money.js';
import { tenantHealthSchema } from '../tenant-health.js';
import { checkUsageDailyWindow, tenantUsageWindowFields } from '../usage.js';
import { portalRecentCallSchema } from './cdrs.js';

export const PORTAL_HOME_RECENT_CALLS = 10;

/** 门户首页的消费指标：与后台概况同口径，但没有未接通通数。 */
export const portalUsageSchema = z
  .strictObject(tenantUsageWindowFields)
  .superRefine(checkUsageDailyWindow);

export const portalHomeResponseSchema = z.strictObject({
  currency: currencySchema,
  balance: moneyAmountSchema,
  overdraftLimit: nonnegativeMoneyAmountSchema,
  /** 余额加透支额度，可为负或零（已停机）。 */
  availableBalance: moneyAmountSchema,
  health: tenantHealthSchema,
  usage: portalUsageSchema,
  /** 最近的话单，按时间倒序，最多 10 条。 */
  recentCalls: z.array(portalRecentCallSchema).max(PORTAL_HOME_RECENT_CALLS),
});
export type PortalHomeResponse = z.infer<typeof portalHomeResponseSchema>;
