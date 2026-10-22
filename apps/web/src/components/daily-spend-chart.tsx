import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
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

/**
 * 横轴标注的位置。后台概况稿电脑 5 个、手机只留首、中、尾；门户首页稿电脑与手机都是每 5 天一个，
 * 含首尾共 7 个（1a、1b）。
 */
const dateTicks = {
  admin: [
    { index: 0, mobile: true },
    { index: 7, mobile: false },
    { index: 14, mobile: true },
    { index: 21, mobile: false },
    { index: 29, mobile: true },
  ],
  portal: [0, 5, 10, 15, 20, 25, 29].map((index) => ({
    index,
    mobile: true,
  })),
} as const;

/** 气泡贴边的柱数：靠近两端时左对齐或右对齐，避免超出图表。 */
const bubbleEdge = 3;

/** 最近 30 天每日消费柱状图，后台概况与门户首页共用；提示只有日期与金额。 */
export function DailyChart({
  currency,
  days,
  variant = 'admin',
}: {
  currency: Currency;
  days: readonly { date: string; spend: string }[];
  /** `portal` 是客户首页稿（7 个日期、手机柱距 8 px），`admin` 是后台概况稿。 */
  variant?: 'admin' | 'portal';
}) {
  const [active, setActive] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);
  // 触屏点一根柱子后气泡一直留着，点图表外面收起；鼠标移开与失焦也收起。
  useEffect(() => {
    if (active === null) return;
    const close = (event: PointerEvent) => {
      if (!list.current?.contains(event.target as Node)) setActive(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [active]);
  const move = (event: KeyboardEvent) => {
    const last = days.length - 1;
    const next = {
      ArrowLeft: Math.max((active ?? last) - 1, 0),
      ArrowRight: Math.min((active ?? last) + 1, last),
      Home: 0,
      End: last,
    }[event.key];
    if (event.key === 'Escape') setActive(null);
    if (next === undefined) return;
    event.preventDefault();
    setActive(next);
  };
  const shown = active === null ? null : days[active];
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
        <div className="relative">
          <ol
            ref={list}
            // 键盘：Tab 进入后用方向键、Home、End 逐根查看，Esc 收起。
            tabIndex={0}
            aria-label={`最近 ${days.length} 天每日消费`}
            onFocus={() => setActive((current) => current ?? days.length - 1)}
            onBlur={() => setActive(null)}
            onKeyDown={move}
            onPointerLeave={(event) => {
              if (event.pointerType === 'mouse') setActive(null);
            }}
            className={cn(
              'm-0 flex h-[120px] list-none items-end border-b border-border p-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:h-[200px] md:bg-[linear-gradient(var(--border)_1px,transparent_1px)] md:bg-size-[100%_33.333%] md:gap-1.5',
              variant === 'portal' ? 'gap-2' : 'gap-[3px]',
            )}
          >
            {days.map((day, index) => {
              const today = index === days.length - 1;
              const label = `${day.date}${today ? '（今日）' : ''} ${formatMoney({ currency, amount: day.spend })}`;
              return (
                <li
                  key={day.date}
                  aria-label={label}
                  aria-current={today ? 'date' : undefined}
                  onPointerEnter={(event) => {
                    if (event.pointerType === 'mouse') setActive(index);
                  }}
                  onPointerDown={() => setActive(index)}
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
          {shown && active !== null ? (
            <div
              aria-hidden
              data-testid="chart-bubble"
              style={
                active < bubbleEdge
                  ? { left: 0 }
                  : active >= days.length - bubbleEdge
                    ? { right: 0 }
                    : {
                        left: `calc((${active} + 0.5) / ${days.length} * 100%)`,
                        transform: 'translateX(-50%)',
                      }
              }
              className="pointer-events-none absolute top-0 z-10 flex flex-col gap-0.5 rounded-md bg-foreground px-2.5 py-1.5 text-xs whitespace-nowrap text-background tabular-nums md:-top-1.5"
            >
              <span className="opacity-70">
                {shown.date}
                {active === days.length - 1 ? '（今日）' : ''}
              </span>
              <span className="font-semibold">
                {formatMoney({ currency, amount: shown.spend })}
              </span>
            </div>
          ) : null}
        </div>
        <div
          aria-hidden
          data-testid="chart-dates"
          className="flex justify-between text-[11px] text-muted-foreground tabular-nums"
        >
          {dateTicks[variant].map(({ index, mobile }) => (
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
