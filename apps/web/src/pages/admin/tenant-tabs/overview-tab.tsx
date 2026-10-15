import { skipToken, useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import type { Currency } from '@fs-billing/shared';
import { QueryError } from '../../../components/query-error';
import { formatMoney } from '../../../lib/format';
import {
  dailyTotal,
  tenantOverviewSource,
  type TenantOverview,
  type TenantOverviewSource,
} from '../../../lib/tenant-overview';
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
        'flex flex-col gap-1.5 rounded-xl border border-border px-5 py-[18px] tabular-nums',
        className,
      )}
    >
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[26px] font-semibold">{value}</span>
      <span className="text-xs text-muted-foreground">{sub}</span>
    </section>
  );
}

function minutes(value: string) {
  return `${countFormat.format(new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber())}分钟`;
}

function DailyChart({
  currency,
  days,
}: {
  currency: Currency;
  days: TenantOverview['dailyConsumption'];
}) {
  const peak = days.reduce(
    (max, day) => Decimal.max(max, day.amount),
    new Decimal(0),
  );
  const last = days.at(-1)?.date;
  return (
    <div className="flex flex-col gap-2">
      <div
        role="img"
        aria-label={`最近 ${days.length} 天每日消费柱状图`}
        className="flex h-[200px] items-end gap-1 border-b border-border md:gap-1.5"
      >
        {days.map((day) => (
          <div
            key={day.date}
            title={`${day.date} ${formatMoney({ currency, amount: day.amount })}`}
            style={{
              height: peak.isZero()
                ? '0%'
                : `${new Decimal(day.amount).div(peak).times(100).toFixed(1)}%`,
            }}
            className={cn(
              'flex-1 rounded-t-[3px]',
              day.date === last ? 'bg-primary' : 'bg-brand-border',
            )}
          />
        ))}
      </div>
      {days.length ? (
        <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{days[0]?.date.slice(5)}</span>
          <span>{last?.slice(5)}</span>
        </div>
      ) : null}
    </div>
  );
}

/** 概况（设计稿第三批 1a/3a）。统计接口上线前显示“数据即将上线”。 */
export function OverviewTab({
  tenantId,
  currency,
  source = tenantOverviewSource,
}: {
  tenantId: string;
  currency: Currency;
  source?: TenantOverviewSource | null;
}) {
  const query = source?.(tenantId);
  const overview = useQuery({
    queryKey: query?.queryKey ?? ['overview-unavailable'],
    queryFn: query?.queryFn ?? skipToken,
  });
  if (!source)
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
  const money = (amount: string) => formatMoney({ currency, amount });
  const days = data.dailyConsumption;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 md:gap-4">
        <StatCard
          label="本月消费"
          value={money(data.monthConsumption)}
          sub="本月至今 · 北京时间"
        />
        <StatCard
          label="本月通话"
          value={minutes(data.monthCallMinutes)}
          sub={
            data.monthCallCount === null
              ? '通话数即将上线'
              : `${countFormat.format(data.monthCallCount)} 通${
                  data.monthUnansweredCount === null
                    ? ''
                    : ` · 含未接通 ${countFormat.format(data.monthUnansweredCount)}`
                }`
          }
        />
        <StatCard
          label="今日消费"
          value={
            data.todayConsumption === null ? '—' : money(data.todayConsumption)
          }
          sub={data.todayConsumption === null ? '数据即将上线' : '今日至今'}
          className="hidden md:flex"
        />
      </div>
      <section
        aria-label="最近 30 天每日消费"
        className="flex flex-col gap-4 rounded-xl border border-border px-4 py-4 md:px-6 md:py-5"
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold">最近 30 天每日消费</span>
            {days.length ? (
              <span className="text-xs text-muted-foreground tabular-nums">
                {days[0]?.date} 至 {days.at(-1)?.date} · 与客户门户首页一致
              </span>
            ) : null}
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs text-muted-foreground">合计</span>
            <span className="text-lg font-semibold tabular-nums">
              {money(dailyTotal(days))}
            </span>
          </div>
        </div>
        {days.length ? (
          <DailyChart currency={currency} days={days} />
        ) : (
          <span className="py-12 text-center text-[13px] text-muted-foreground">
            最近 30 天没有消费
          </span>
        )}
      </section>
    </div>
  );
}
