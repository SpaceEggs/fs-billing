import { z } from 'zod';
import { currencySchema } from './identity.js';
import { nonnegativeMoneyAmountSchema as nonnegativeAmount } from './money.js';

/**
 * 后台概况与门户首页共有的指标。门户不显示未接通通数，所以该字段不在这里，
 * 门户响应因此无法表示它（见 docs/phase-6-design.md）。
 */
export const tenantUsageWindowFields = {
  asOf: z.iso.datetime({ offset: true }),
  monthSpend: nonnegativeAmount,
  monthCallMinutes: z.string().regex(/^\d+(?:\.\d+)?$/),
  answeredCalls: z.int().nonnegative(),
  daily: z
    .array(z.strictObject({ date: z.iso.date(), spend: nonnegativeAmount }))
    .length(30),
  dailyTotal: nonnegativeAmount,
};

/** daily 恰好是截至 asOf 北京日期当天的连续 30 天。 */
export function checkUsageDailyWindow(
  value: { asOf: string; daily: readonly { date: string }[] },
  context: z.RefinementCtx,
) {
  const instant = Date.parse(value.asOf);
  if (!Number.isFinite(instant)) return;
  // Asia/Shanghai uses UTC+8 without DST, per the overview date-boundary decision.
  const today = new Date(instant + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00Z`);
  value.daily.forEach((day, index) => {
    const expected = new Date(midnight - (29 - index) * 86400000)
      .toISOString()
      .slice(0, 10);
    if (day.date !== expected)
      context.addIssue({
        code: 'custom',
        path: ['daily', index, 'date'],
        message: '消费日期必须为截至 asOf 北京时间当天的连续 30 天',
      });
  });
}

export const tenantUsageOverviewSchema = z
  .strictObject({
    ...tenantUsageWindowFields,
    currency: currencySchema,
    unansweredCalls: z.int().nonnegative(),
  })
  .superRefine(checkUsageDailyWindow);

export type TenantUsageOverview = z.infer<typeof tenantUsageOverviewSchema>;
