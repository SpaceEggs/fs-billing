import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import Decimal from 'decimal.js';
import type { Identity, PortalHomeResponse } from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { DailyChart } from '../../components/daily-spend-chart';
import { Money } from '../../components/data-format';
import { LoadError } from '../../components/load-error';
import { RecentCalls } from '../../components/portal/recent-calls';
import { StatusTag } from '../../components/status-tag';
import { healthStatus } from '../../components/tenant-health';
import { CalloutIcon } from '../../components/ui/alert';
import { apiQuery } from '../../lib/admin-api';
import { formatMoney, formatMonth } from '../../lib/format';
import { cn } from '../../lib/utils';

const countFormat = new Intl.NumberFormat('en-US');

function minutes(value: string) {
  return countFormat.format(
    new Decimal(value).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber(),
  );
}

/** 已停机横幅（设计稿 1c）。管理员停用的租户不显示（决定 28）。 */
function SuspendedBanner() {
  return (
    <div
      role="alert"
      className="flex items-start gap-2.5 rounded-[10px] border border-err-border bg-err-soft p-3.5 text-err"
    >
      <CalloutIcon tone="err" />
      <div className="flex flex-col gap-1">
        <span className="text-[15px] font-semibold">余额不足，已暂停呼叫</span>
        <span className="text-[13px] leading-normal">
          请联系客服充值，到账后自动恢复呼叫。
        </span>
      </div>
    </div>
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
    <section
      aria-label={label}
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-card p-3.5 tabular-nums md:gap-2 md:p-5"
    >
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
  );
}

function HealthNote({ home }: { home: PortalHomeResponse }) {
  if (home.health !== 'overdraft') return null;
  return (
    <span className="text-[13px] font-normal text-muted-foreground">
      余额已为负数，可用额度仍有{' '}
      <Money
        value={{ currency: home.currency, amount: home.availableBalance }}
        tone="plain"
      />
    </span>
  );
}

function Stats({ home }: { home: PortalHomeResponse }) {
  const money = (amount: string) => ({ currency: home.currency, amount });
  const { usage } = home;
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-4">
      <StatCard
        label="当前余额"
        sub={
          <>
            可用额度 <Money value={money(home.availableBalance)} tone="plain" />
          </>
        }
      >
        <Money value={money(home.balance)} />
      </StatCard>
      <StatCard label="透支额度" sub="余额 + 透支额度用完后暂停呼叫">
        <Money value={money(home.overdraftLimit)} tone="plain" />
      </StatCard>
      <StatCard label="本月消费" sub={`${formatMonth(usage.asOf)} · 截至今日`}>
        <Money value={money(usage.monthSpend)} tone="plain" />
      </StatCard>
      <StatCard
        label="本月通话分钟数"
        mobileLabel="本月通话"
        sub={`已接通 ${countFormat.format(usage.answeredCalls)} 通`}
      >
        {minutes(usage.monthCallMinutes)}
        <span className="ml-1 text-xs font-normal text-muted-foreground md:text-[15px]">
          分钟
        </span>
      </StatCard>
    </div>
  );
}

function DailySpend({ home }: { home: PortalHomeResponse }) {
  const { daily, dailyTotal } = home.usage;
  const total = formatMoney({ currency: home.currency, amount: dailyTotal });
  return (
    <section
      aria-label="最近 30 天每日消费"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card py-3.5 md:gap-4 md:px-6 md:py-5"
    >
      <div className="flex items-baseline justify-between gap-3 px-3.5 md:px-0">
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold md:text-base">
            <span className="md:hidden">最近 30 天消费</span>
            <span className="hidden md:inline">最近 30 天每日消费</span>
          </span>
          <span className="hidden text-xs text-muted-foreground tabular-nums md:inline">
            {daily[0]?.date} 至 {daily.at(-1)?.date}
          </span>
        </div>
        <div className="hidden flex-col items-end gap-1 md:flex">
          <span className="text-xs text-muted-foreground">合计</span>
          <span
            aria-label={`合计 ${total}`}
            className="text-lg font-semibold tabular-nums"
          >
            {total}
          </span>
        </div>
        <span className="text-xs text-muted-foreground md:hidden">
          ← 左右滑动
        </span>
      </div>
      <div className="overflow-x-auto px-3.5 md:overflow-visible md:px-0">
        <div className="min-w-[620px] md:min-w-0">
          <DailyChart currency={home.currency} days={daily} variant="portal" />
        </div>
      </div>
    </section>
  );
}

/**
 * 空状态（设计稿 1d）：从未有过已接通话单，图表与列表都不显示（决定 29）。
 * 稿中的插图是标着「空状态插图」的斜纹占位框，这里照样画斜纹框，不写占位说明文字。
 */
function NoCalls() {
  return (
    <section
      aria-label="没有通话记录"
      className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border px-4 py-7 text-center"
    >
      <div
        aria-hidden
        className="h-[68px] w-24 rounded-lg border border-border bg-[repeating-linear-gradient(135deg,var(--muted)_0_6px,transparent_6px_12px)]"
      />
      <span className="text-[15px] font-semibold">没有通话记录</span>
      <span className="text-[13px] leading-relaxed text-muted-foreground">
        开始外呼后，消费图表和最近话单会显示在这里
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
            aria-label="最近话单"
            className="flex flex-col gap-2 md:gap-0 md:overflow-hidden md:rounded-xl md:border md:border-border md:bg-card"
          >
            <div className="flex items-center justify-between md:px-6 md:py-4">
              <h2 className="m-0 text-[15px] font-semibold md:text-base">
                <span className="md:hidden">最近话单</span>
                <span className="hidden md:inline">最近 10 通话单</span>
              </h2>
              <Link
                to="/portal/cdrs"
                className="text-sm font-medium text-primary underline underline-offset-[3px]"
              >
                查看全部
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
  const home = useQuery(apiQuery('portalHome'));
  const tenant = identity.kind === 'customer' ? identity.tenant : null;
  const data = home.data;
  return (
    <AppShell
      identity={identity}
      title="首页"
      crumb={tenant ? `${tenant.code} · ${tenant.name}` : ''}
      activeNav="首页"
    >
      <PageBody
        title="首页"
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
          <div
            aria-busy
            aria-label="首页加载中"
            className="h-[320px] animate-pulse rounded-xl bg-skeleton"
          />
        )}
      </PageBody>
    </AppShell>
  );
}
