import { useQuery } from '@tanstack/react-query';
import Decimal from 'decimal.js';
import { DailyChart } from '../../../components/daily-spend-chart';
import { QueryError } from '../../../components/query-error';
import { apiQuery } from '../../../lib/admin-api';
import { formatDate, formatMoney, formatTime } from '../../../lib/format';
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

/** 概况（设计稿第三批 1a/3a）。 */
export function OverviewTab({ tenantId }: { tenantId: string }) {
  const overview = useQuery(
    apiQuery('adminTenantOverview', { params: { tenantId } }),
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
