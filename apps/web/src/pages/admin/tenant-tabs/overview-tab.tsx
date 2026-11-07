import { Card } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { beijingDateOf } from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { DailyChart } from '../../../components/daily-spend-chart';
import { formatCount, formatMinutes } from '../../../components/cdr/cdr-format';
import { QueryError } from '../../../components/query-error';
import { apiQuery } from '../../../lib/admin-api';
import { formatDay, formatMoney, formatTime } from '../../../lib/format';
import { useLocale } from '../../../i18n';
import { cn } from '../../../lib/utils';

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
    <Card
      asChild
      className={cn(
        'block gap-0 bg-transparent py-0 text-inherit shadow-none',
        cn(
          'flex flex-col gap-1 rounded-xl border border-border p-3.5 tabular-nums md:gap-1.5 md:px-5 md:py-[18px]',
          className,
        ),
      )}
    >
      <section aria-label={label}>
        <span className="text-xs text-muted-foreground md:text-[13px]">
          {label}
        </span>
        <span className="text-[19px] font-semibold md:text-[26px]">
          {value}
        </span>
        <span className="hidden text-xs text-muted-foreground md:block">
          {sub}
        </span>
      </section>
    </Card>
  );
}

/** 概况（设计稿第三批 1a/3a）。 */
export function OverviewTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation(['tenant', 'common']);
  const locale = useLocale();
  const overview = useQuery(
    apiQuery('adminTenantOverview', { params: { tenantId } }),
  );
  if (overview.isError)
    return (
      <QueryError
        title={t('tenant:overview.loadFailed')}
        error={overview.error}
        retrying={overview.isFetching}
        onRetry={() => void overview.refetch()}
      />
    );
  const data = overview.data;
  if (!data)
    return (
      <Skeleton
        aria-busy
        aria-label={t('tenant:overview.loading')}
        className="h-[320px] rounded-xl"
      />
    );
  const money = (amount: string) =>
    formatMoney({ currency: data.currency, amount });
  const days = data.daily;
  const today = days.at(-1);
  const monthStart = `${beijingDateOf(data.asOf).slice(0, 8)}01`;
  return (
    <div className="flex flex-col gap-3 md:gap-5">
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3 md:gap-4">
        <StatCard
          label={t('tenant:overview.monthSpend')}
          value={money(data.monthSpend)}
          sub={t('tenant:overview.monthSpendSub', {
            date: formatDay(monthStart, locale),
            time: formatTime(data.asOf),
          })}
        />
        <StatCard
          label={t('tenant:overview.monthCalls')}
          value={formatMinutes(data.monthCallMinutes, locale)}
          sub={t('tenant:overview.monthCallsSub', {
            calls: formatCount(data.answeredCalls + data.unansweredCalls),
            unanswered: formatCount(data.unansweredCalls),
          })}
        />
        <StatCard
          label={t('tenant:overview.todaySpend')}
          value={today ? money(today.spend) : '—'}
          sub={t('tenant:overview.asOf', { time: formatTime(data.asOf) })}
          className="hidden md:flex"
        />
      </div>
      <Card
        asChild
        className={cn(
          'block gap-0 bg-transparent py-0 text-inherit shadow-none',
          'flex flex-col gap-2.5 rounded-xl border border-border p-3.5 md:gap-4 md:px-6 md:py-5',
        )}
      >
        <section aria-label={t('tenant:overview.chartAria')}>
          <div className="flex items-baseline justify-between gap-3">
            <div className="flex flex-col gap-1">
              <span className="text-sm font-semibold md:text-base">
                <span className="md:hidden">
                  {t('tenant:overview.chartTitleMobile')}
                </span>
                <span className="hidden md:inline">
                  {t('tenant:overview.chartTitle')}
                </span>
              </span>
              <span className="hidden text-xs text-muted-foreground tabular-nums md:inline">
                {t('tenant:overview.chartRange', {
                  from: formatDay(days[0]?.date ?? monthStart, locale),
                  to: formatDay(today?.date ?? monthStart, locale),
                })}
              </span>
            </div>
            <div className="flex flex-col items-end gap-1">
              <span className="hidden text-xs text-muted-foreground md:inline">
                {t('tenant:overview.total')}
              </span>
              <span
                aria-label={t('tenant:overview.totalAria', {
                  amount: money(data.dailyTotal),
                })}
                className="text-sm font-semibold tabular-nums md:text-lg"
              >
                {money(data.dailyTotal)}
              </span>
            </div>
          </div>
          <DailyChart currency={data.currency} days={days} />
        </section>
      </Card>
    </div>
  );
}
