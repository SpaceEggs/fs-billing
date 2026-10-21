import Decimal from 'decimal.js';
import type { Currency } from '@fs-billing/shared';
import { formatMoney } from '../lib/format';
import { cn } from '../lib/utils';

/** 纵轴三格：每格取 1、2、2.5、4、5 × 10ⁿ 中能容纳峰值的最小值。 */
function axisStep(peak: Decimal) {
  if (peak.isZero()) return null;
  const base = new Decimal(10).pow(
    Math.floor(Math.log10(peak.div(3).toNumber())),
  );
  for (const factor of [1, 2, 2.5, 4, 5, 10]) {
    const step = base.times(factor);
    if (step.times(3).gte(peak)) return step;
  }
  return base.times(10);
}

/** 横轴标注的位置：电脑 5 个，手机只留首、中、尾。 */
const dateTicks = [
  { index: 0, mobile: true },
  { index: 7, mobile: false },
  { index: 14, mobile: true },
  { index: 21, mobile: false },
  { index: 29, mobile: true },
];

/** 最近 30 天每日消费柱状图，后台概况与门户首页共用；提示只有日期与金额。 */
export function DailyChart({
  currency,
  days,
}: {
  currency: Currency;
  days: readonly { date: string; spend: string }[];
}) {
  const peak = days.reduce(
    (max, day) => Decimal.max(max, day.spend),
    new Decimal(0),
  );
  const step = axisStep(peak);
  const top = step?.times(3) ?? null;
  const tick = (amount: Decimal) =>
    formatMoney({ currency, amount: amount.toFixed() }).replace(/\.00$/, '');
  return (
    <div className="flex gap-3">
      {step ? (
        <div
          aria-hidden
          className="hidden h-[200px] w-9 flex-col justify-between text-right text-[11px] text-muted-foreground tabular-nums md:flex"
        >
          {[3, 2, 1, 0].map((n) => (
            <span key={n}>{tick(step.times(n))}</span>
          ))}
        </div>
      ) : null}
      <div className="relative flex flex-1 flex-col gap-2">
        {top ? null : (
          <span className="absolute inset-x-0 top-[40px] text-center text-[13px] text-muted-foreground md:top-[90px]">
            最近 30 天没有消费
          </span>
        )}
        <ol
          aria-label={`最近 ${days.length} 天每日消费`}
          className="m-0 flex h-[120px] list-none items-end gap-[3px] border-b border-border p-0 md:h-[200px] md:bg-[linear-gradient(var(--border)_1px,transparent_1px)] md:bg-size-[100%_33.333%] md:gap-1.5"
        >
          {days.map((day, index) => {
            const today = index === days.length - 1;
            const label = `${day.date}${today ? '（今日）' : ''} ${formatMoney({ currency, amount: day.spend })}`;
            return (
              <li
                key={day.date}
                aria-label={label}
                title={label}
                aria-current={today ? 'date' : undefined}
                style={{
                  height: top
                    ? `${new Decimal(day.spend).div(top).times(100).toFixed(1)}%`
                    : '0%',
                }}
                className={cn(
                  'flex-1 rounded-t-[2px] md:rounded-t-[3px]',
                  today ? 'bg-primary' : 'bg-brand-border',
                )}
              />
            );
          })}
        </ol>
        <div
          aria-hidden
          className="flex justify-between text-[11px] text-muted-foreground tabular-nums"
        >
          {dateTicks.map(({ index, mobile }) => (
            <span
              key={index}
              className={mobile ? undefined : 'hidden md:inline'}
            >
              {days[index]?.date.slice(5)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
