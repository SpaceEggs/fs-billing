import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import type { Currency } from '@fs-billing/shared';
import { webConfig } from '../../../config';
import { QueryError } from '../../../components/query-error';
import { formatDate, formatMoney, formatTime } from '../../../lib/format';
import { tenantOverviewQuery } from '../../../lib/tenant-overview';
import type { TenantUsageOverview } from '../../../lib/usage-overview-mirror';
import { cn } from '../../../lib/utils';

const countFormat = new Intl.NumberFormat('en-US');

function StatCard({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: string;
  sub: string;
  className?: string;
}) {
  return (
    <section
      aria-label={label}
      className={cn(
        'flex flex-col gap-1 rounded-xl border border-border p-3.5 tabular-nums md:gap-1.5 md:px-5 md:py-[18px]',
        className,
      )}
    >
      <span className="text-xs text-muted-foreground md:text-[13px]">
        {label}
      </span>
      <span className="text-[19px] font-semibold md:text-[26px]">{value}</span>
      <span className="hidden text-xs text-muted-foreground md:block">
        {sub}
      </span>
    </section>
  );
}

function minutes(value: string) {
  return `${countFormat.format(new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber())}分钟`;
}

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

function DailyChart({
  currency,
  days,
}: {
  currency: Currency;
  days: TenantUsageOverview['daily'];
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
          className="m-0 flex h-[120px] list-none items-end gap-[3px] border-b border-border bg-[linear-gradient(var(--border)_1px,transparent_1px)] bg-size-[100%_33.333%] p-0 md:h-[200px] md:gap-1.5"
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

function ComingSoon() {
  return (
    <div className="flex flex-col gap-5">
      <div
        role="status"
        className="flex flex-col gap-0.5 rounded-lg border border-brand-border bg-brand-soft px-3.5 py-2.5 text-[13px] leading-normal"
      >
        <span className="font-semibold text-primary">概况数据即将上线</span>
        <span>
          本月消费、通话统计和最近 30
          天每日消费将在统计接口上线后显示。当前余额见上方卡片，入账明细见「余额流水」。
        </span>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <StatCard label="本月消费" value="—" sub="数据即将上线" />
        <StatCard label="本月通话" value="—" sub="数据即将上线" />
        <StatCard
          label="今日消费"
          value="—"
          sub="数据即将上线"
          className="hidden md:flex"
        />
      </div>
      <section
        aria-label="最近 30 天每日消费"
        className="flex flex-col gap-1 rounded-xl border border-border px-6 py-5"
      >
        <span className="text-base font-semibold">最近 30 天每日消费</span>
        <span className="py-16 text-center text-[13px] text-muted-foreground">
          数据即将上线
        </span>
      </section>
    </div>
  );
}

/**
 * 概况（设计稿第三批 1a/3a）。统计接口（PR #24）上线前由 `VITE_TENANT_OVERVIEW`
 * 关闭，显示“数据即将上线”且不发请求。
 */
export function OverviewTab({
  tenantId,
  enabled = webConfig.tenantOverviewEnabled,
}: {
  tenantId: string;
  enabled?: boolean;
}) {
  return enabled ? <Overview tenantId={tenantId} /> : <ComingSoon />;
}

function Overview({ tenantId }: { tenantId: string }) {
  const overview = useQuery(tenantOverviewQuery(tenantId));
  if (overview.isError)
    return (
      <QueryError
        title="概况加载失败"
        error={overview.error}
        retrying={overview.isFetching}
        onRetry={() => void overview.refetch()}
      />
    );
  const data = overview.data;
  if (!data)
    return (
      <div
        aria-busy
        aria-label="概况加载中"
        className="h-[320px] animate-pulse rounded-xl bg-skeleton"
      />
    );
  const money = (amount: string) =>
    formatMoney({ currency: data.currency, amount });
  const days = data.daily;
  const today = days.at(-1);
  return (
    <div className="flex flex-col gap-3 md:gap-5">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4">
        <StatCard
          label="本月消费"
          value={money(data.monthSpend)}
          sub={`${formatDate(data.asOf).slice(0, 8)}01 至今 · 截至 ${formatTime(data.asOf)}`}
        />
        <StatCard
          label="本月通话"
          value={minutes(data.monthCallMinutes)}
          sub={`${countFormat.format(data.answeredCalls + data.unansweredCalls)} 通 · 含未接通 ${countFormat.format(data.unansweredCalls)}`}
        />
        <StatCard
          label="今日消费"
          value={today ? money(today.spend) : '—'}
          sub={`截至 ${formatTime(data.asOf)}`}
          className="hidden md:flex"
        />
      </div>
      <section
        aria-label="最近 30 天每日消费"
        className="flex flex-col gap-2.5 rounded-xl border border-border p-3.5 md:gap-4 md:px-6 md:py-5"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold md:text-base">
              <span className="md:hidden">最近 30 天消费</span>
              <span className="hidden md:inline">最近 30 天每日消费</span>
            </span>
            <span className="hidden text-xs text-muted-foreground tabular-nums md:inline">
              {days[0]?.date} 至 {today?.date} · 与客户门户首页一致
            </span>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="hidden text-xs text-muted-foreground md:inline">
              合计
            </span>
            <span
              aria-label={`合计 ${money(data.dailyTotal)}`}
              className="text-sm font-semibold tabular-nums md:text-lg"
            >
              {money(data.dailyTotal)}
            </span>
          </div>
        </div>
        <DailyChart currency={data.currency} days={days} />
      </section>
    </div>
  );
}
