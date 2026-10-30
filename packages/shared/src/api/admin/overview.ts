import { z } from 'zod';
import { moneyAmountSchema } from '../money.js';
import { tenantIdentitySchema } from '../identity.js';
import { tenantHealthSchema } from '../tenant-health.js';
import {
  adminNonnegativeAmountSchema,
  adminTimestampSchema,
} from './common.js';
import { adminCurrencyTotalsSchema } from './receivables.js';
import { adminSystemAlertSchema } from './system-alerts.js';

/**
 * 概览页（阶段 9 设计「两个页面的数字」）。后台专用。
 * 每个数字与对应页面共用同一个函数或谓词：待收款总额 = 待收款页的 `totals`，
 * 告警条数 = 告警页 `window=24h` 的 `total`，未归属 = 未归属页的 `pending`，
 * 已停机 / 余额不足 = 租户列表按状态筛选的 `total`。统计口径沿用 design.md §7.7（北京日期，CNY 与 USD 分开）。
 */
export const OVERVIEW_ATTENTION_ITEMS = 5;
export const OVERVIEW_DAILY_DAYS = 30;

const attentionTenantSchema = tenantIdentitySchema.extend({
  health: tenantHealthSchema,
  balance: moneyAmountSchema,
  availableBalance: moneyAmountSchema,
  overdraftLimit: moneyAmountSchema,
  threshold: moneyAmountSchema.nullable(),
  suspendedAt: adminTimestampSchema.nullable(),
});
const tenantAttentionSchema = z.strictObject({
  total: z.int().nonnegative(),
  /** 与租户列表同一个排序，前 5 条。 */
  items: z.array(attentionTenantSchema).max(OVERVIEW_ATTENTION_ITEMS),
});

export const adminOverviewResponseSchema = z.strictObject({
  /** 数据截至（数据库时间，一个快照）。页面写「数据截至 … · 每分钟刷新」。 */
  asOf: adminTimestampSchema,
  metrics: z.strictObject({
    tenantCount: z.int().nonnegative(),
    /** 今日已接通话单的计费分钟（所有租户，北京日，按接通时间）。 */
    todayCallMinutes: z.string().regex(/^\d+(?:\.\d+)?$/),
    todayCallMinutesByCurrency: z.strictObject({
      CNY: z.string().regex(/^\d+(?:\.\d+)?$/),
      USD: z.string().regex(/^\d+(?:\.\d+)?$/),
    }),
    suspendedTenantsByCurrency: z.strictObject({
      CNY: z.int().nonnegative(),
      USD: z.int().nonnegative(),
    }),
    todaySpend: adminCurrencyTotalsSchema,
    monthSpend: adminCurrencyTotalsSchema,
    /** `adminReceivables` 在 `status=pending` 时的 `totals`。 */
    pendingReceivable: adminCurrencyTotalsSchema,
    /** 已停机租户数，等于 `adminTenants?status=suspended` 的 `total`。 */
    suspendedTenants: z.int().nonnegative(),
  }),
  attention: z.strictObject({
    suspended: tenantAttentionSchema,
    /** 余额不足含透支中（`overdraft` + `low_balance`），等于两个状态筛选的 `total` 之和。 */
    lowBalance: tenantAttentionSchema,
    unassigned: z.strictObject({
      pending: z.int().nonnegative(),
      latestAt: adminTimestampSchema.nullable(),
    }),
    alerts: z.strictObject({
      /** 进行中的告警（红色），等于告警汇总端点的 `open`。 */
      open: z.int().nonnegative(),
      /** 最近 24 小时，等于告警列表 `window=24h` 的 `total`。 */
      last24h: z.int().nonnegative(),
      /** 最近 24 小时窗口里的前 5 条（进行中在前）。 */
      items: z.array(adminSystemAlertSchema).max(OVERVIEW_ATTENTION_ITEMS),
    }),
  }),
  /** 截至 asOf 北京日期当天的连续 30 天，升序；某币种当天没有消费为 "0"。 */
  dailySpend: z
    .array(
      z.strictObject({
        date: z.iso.date(),
        CNY: adminNonnegativeAmountSchema,
        USD: adminNonnegativeAmountSchema,
      }),
    )
    .length(OVERVIEW_DAILY_DAYS),
});
export type AdminOverviewResponse = z.infer<typeof adminOverviewResponseSchema>;
