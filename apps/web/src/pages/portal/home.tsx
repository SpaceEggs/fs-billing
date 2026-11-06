import { Card } from '@/components/ui/card';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import Decimal from 'decimal.js';
import {
  translate,
  type Identity,
  type PortalHomeResponse,
} from '@fs-billing/shared';
import { Skeleton } from '../../components/ui/skeleton';
import { AppShell, PageBody } from '../../components/app-shell';
import { DailyChart } from '../../components/daily-spend-chart';
import { Money } from '../../components/data-format';
import { LoadError } from '../../components/load-error';
import { RecentCalls } from '../../components/portal/recent-calls';
import { StatusTag } from '../../components/status-tag';
import { healthStatus } from '../../components/tenant-health';
import { CircleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { useLocale } from '../../i18n';
import { apiQuery } from '../../lib/admin-api';
import { formatDay, formatMoney, formatMonth } from '../../lib/format';
import { cn } from '../../lib/utils';

const countFormat = new Intl.NumberFormat('en-US');

function minutes(value: string) {
  return countFormat.format(
    new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  );
}

/** 已停机横幅（设计稿 1c）。管理员停用的租户不显示（决定 28）。 */
function SuspendedBanner() {
  const { t } = useTranslation(['portal']);
  return (
    <Alert variant="error" className="rounded-[10px] p-3.5">
      <CircleAlertIcon aria-hidden />
      <AlertTitle className="text-[15px]">
        {t('portal:home.suspended.title')}
      </AlertTitle>
      <AlertDescription className="leading-normal">
        {t('portal:home.suspended.body')}
      </AlertDescription>
    </Alert>
  );
}

function StatCard({
  label,
  mobileLabel,
  sub,
  className,
  children,
}: {
  label: string;
  mobileLabel?: string;
  sub: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card
      asChild
      className={cn(
        'block gap-0 bg-transparent py-0 text-inherit shadow-none',
        'flex flex-col gap-1.5 rounded-xl border border-border bg-card p-3.5 tabular-nums md:gap-2 md:p-5',
      )}
    >
      <section aria-label={label}>
        <span className="text-xs text-muted-foreground md:text-[13px]">
          {mobileLabel ? (
            <>
              <span className="md:hidden">{mobileLabel}</span>
              <span className="hidden md:inline">{label}</span>
            </>
          ) : (
            label
          )}
        </span>
        <span
          className={cn(
            'text-[22px] leading-tight font-semibold tracking-[-0.02em] md:text-[30px]',
            className,
          )}
        >
          {children}
        </span>
        <span className="hidden text-xs text-muted-foreground md:block">
          {sub}
        </span>
      </section>
    </Card>
  );
}

function HealthNote({ home }: { home: PortalHomeResponse }) {
  const { t } = useTranslation(['portal']);
  if (home.health !== 'overdraft') return null;
  return (
    <span className="text-[13px] font-normal text-muted-foreground">
      {t('portal:home.negativeBalance')}{' '}
      <Money
        value={{ currency: home.currency, amount: home.availableBalance }}
        tone="plain"
      />
    </span>
  );
}

function Stats({ home }: { home: PortalHomeResponse }) {
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
  const money = (amount: string) => ({ currency: home.currency, amount });
  const { usage } = home;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-4">
      <StatCard
        label={t('portal:home.balance')}
        sub={
          <>
            {t('portal:home.available')}{' '}
            <Money value={money(home.availableBalance)} tone="plain" />
          </>
        }
      >
        <Money value={money(home.balance)} />
      </StatCard>
      <StatCard
        label={t('portal:home.overdraftLimit')}
        sub={t('portal:home.overdraftNote')}
      >
        <Money value={money(home.overdraftLimit)} tone="plain" />
      </StatCard>
      <StatCard
        label={t('portal:home.monthSpend')}
        sub={t('portal:home.monthSpendSub', {
          month: formatMonth(usage.asOf, locale),
        })}
      >
        <Money value={money(usage.monthSpend)} tone="plain" />
      </StatCard>
      <StatCard
        label={t('portal:home.monthMinutes')}
        mobileLabel={t('portal:home.monthMinutesMobile')}
        sub={t('portal:home.answeredCalls', {
          count: usage.answeredCalls,
          formatted: countFormat.format(usage.answeredCalls),
        })}
      >
        {minutes(usage.monthCallMinutes)}
        <span className="ml-1 text-xs font-normal text-muted-foreground md:text-[15px]">
          {t('portal:home.minutesUnit')}
        </span>
      </StatCard>
    </div>
  );
}

function DailySpend({ home }: { home: PortalHomeResponse }) {
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
  const { daily, dailyTotal } = home.usage;
  const total = formatMoney({ currency: home.currency, amount: dailyTotal });
  const first = daily[0]?.date;
  const last = daily.at(-1)?.date;
  return (
    <Card
      asChild
      className={cn(
        'block gap-0 bg-transparent py-0 text-inherit shadow-none',
        'flex flex-col gap-3 rounded-xl border border-border bg-card py-3.5 md:gap-4 md:px-6 md:py-5',
      )}
    >
      <section aria-label={t('portal:home.daily.label')}>
        <div className="flex items-baseline justify-between gap-3 px-3.5 md:px-0">
          <div className="flex flex-col gap-1">
            <span className="text-[15px] font-semibold md:text-base">
              <span className="md:hidden">
                {t('portal:home.daily.mobileLabel')}
              </span>
              <span className="hidden md:inline">
                {t('portal:home.daily.label')}
              </span>
            </span>
            <span className="hidden text-xs text-muted-foreground tabular-nums md:inline">
              {first && last
                ? t('portal:home.daily.range', {
                    from: formatDay(first, locale),
                    to: formatDay(last, locale),
                  })
                : null}
            </span>
          </div>
          <div className="hidden flex-col items-end gap-1 md:flex">
            <span className="text-xs text-muted-foreground">
              {t('portal:home.daily.total')}
            </span>
            <span
              aria-label={t('portal:home.daily.totalLabel', { total })}
              className="text-lg font-semibold tabular-nums"
            >
              {total}
            </span>
          </div>
          <span className="text-xs text-muted-foreground md:hidden">
            {t('portal:home.daily.swipe')}
          </span>
        </div>
        <div className="overflow-x-auto px-3.5 md:overflow-visible md:px-0">
          <div className="min-w-[620px] md:min-w-0">
            <DailyChart
              currency={home.currency}
              days={daily}
              variant="portal"
            />
          </div>
        </div>
      </section>
    </Card>
  );
}

/**
 * 空状态（设计稿 1d）：从未有过已接通话单，图表与列表都不显示（决定 29）。
 * 稿中的插图是标着「空状态插图」的斜纹占位框，这里照样画斜纹框，不写占位说明文字。
 */
function NoCalls() {
  const { t } = useTranslation(['portal']);
  return (
    <section
      aria-label={t('portal:home.noCalls.label')}
      className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-7 text-center"
    >
      <div
        aria-hidden
        className="h-[68px] w-24 rounded-lg border border-border bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,transparent_6px_12px)]"
      />
      <span className="text-[15px] font-semibold">
        {t('portal:home.noCalls.title')}
      </span>
      <span className="text-[13px] leading-relaxed text-muted-foreground">
        {t('portal:home.noCalls.body')}
      </span>
    </section>
  );
}

function HomeContent({
  home,
  code,
}: {
  home: PortalHomeResponse;
  code: string;
}) {
  const { t } = useTranslation(['portal', 'common']);
  const locale = useLocale();
  const hasCalls = home.recentCalls.length > 0;
  return (
    <div className="flex flex-col gap-4 md:gap-6">
      {home.health === 'suspended' ? <SuspendedBanner /> : null}
      <div className="flex items-center justify-between md:hidden">
        <span className="text-[13px] text-muted-foreground">
          {code} · {home.currency}
        </span>
        <StatusTag
          status={healthStatus[home.health]}
          className="h-[22px]"
          alwaysDot
        />
      </div>
      <Stats home={home} />
      {hasCalls ? (
        <>
          <DailySpend home={home} />
          <section
            aria-label={t('portal:home.recent.label')}
            className="flex flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-border md:bg-card"
          >
            <div className="flex items-center justify-between md:px-6 md:py-4">
              <div className="flex flex-col">
                <h2 className="m-0 text-[15px] font-semibold md:text-base">
                  <span className="md:hidden">
                    {t('portal:home.recent.mobileTitle')}
                  </span>
                  <span className="hidden md:inline">
                    {t('portal:home.recent.title')}
                  </span>
                </h2>
                {locale === 'en' ? (
                  <span className="text-xs text-muted-foreground">
                    {t('common:timezone.beijing')}
                  </span>
                ) : null}
              </div>
              <Link
                to="/portal/cdrs"
                className="text-sm font-medium text-primary underline underline-offset-[3px]"
              >
                {t('portal:home.recent.all')}
                <span aria-hidden className="hidden md:inline">
                  {' →'}
                </span>
              </Link>
            </div>
            <RecentCalls currency={home.currency} calls={home.recentCalls} />
          </section>
        </>
      ) : (
        <NoCalls />
      )}
    </div>
  );
}

export function PortalHome({ identity }: { identity: Identity }) {
  const { t } = useTranslation(['portal', 'shell']);
  const home = useQuery(apiQuery('portalHome'));
  const tenant = identity.kind === 'customer' ? identity.tenant : null;
  const data = home.data;
  return (
    <AppShell
      identity={identity}
      title={t('shell:nav.home')}
      crumb={tenant ? `${tenant.code} · ${tenant.name}` : ''}
      activeNav={translate('zh', 'shell:nav.home')}
    >
      <PageBody
        title={t('shell:nav.home')}
        badge={
          data ? (
            <span className="flex items-center gap-3">
              <StatusTag status={healthStatus[data.health]} alwaysDot />
              <HealthNote home={data} />
            </span>
          ) : undefined
        }
      >
        {data ? (
          <HomeContent home={data} code={tenant?.code ?? ''} />
        ) : home.isError ? (
          <LoadError
            error={home.error}
            retrying={home.isFetching}
            onRetry={() => void home.refetch()}
          />
        ) : (
          <Skeleton
            aria-busy
            aria-label={t('portal:home.loading')}
            className="h-[320px] rounded-xl"
          />
        )}
      </PageBody>
    </AppShell>
  );
}
