import { z } from 'zod';
import { currencySchema } from './identity.js';
import { moneyAmountSchema } from './money.js';

const nonnegativeAmount = moneyAmountSchema.refine(
  (value) => !value.startsWith('-'),
  { message: '金额不能为负' },
);

export const tenantUsageOverviewSchema = z
  .strictObject({
    asOf: z.iso.datetime({ offset: true }),
    currency: currencySchema,
    monthSpend: nonnegativeAmount,
    monthCallMinutes: z.string().regex(/^\d+(?:\.\d+)?$/),
    answeredCalls: z.int().nonnegative(),
    unansweredCalls: z.int().nonnegative(),
    daily: z
      .array(z.strictObject({ date: z.iso.date(), spend: nonnegativeAmount }))
      .length(30),
    dailyTotal: nonnegativeAmount,
  })
  .superRefine((value, context) => {
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
  });

export type TenantUsageOverview = z.infer<typeof tenantUsageOverviewSchema>;
