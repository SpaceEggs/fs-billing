import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import Decimal from 'decimal.js';
import type { AdminOverviewResponse, Identity } from '@fs-billing/shared';
import { AppShell, PageBody } from '../components/app-shell';
import { DailyChart } from '../components/daily-spend-chart';
import { Money } from '../components/data-format';
import { LoadError } from '../components/load-error';
import { Segmented } from '../components/segmented';
import { StatusTag } from '../components/status-tag';
import { healthStatus } from '../components/tenant-health';
import { Badge } from '../components/ui/badge';
import { apiQuery } from '../lib/admin-api';
import { formatDateTime, formatMoney } from '../lib/format';
import { cn } from '../lib/utils';

type TenantGroup = AdminOverviewResponse['attention']['suspended'];
function TenantAttention({
  title,
  group,
  suspended = false,
}: {
  title: string;
  group: TenantGroup;
  suspended?: boolean;
}) {
  if (!group.total) return null;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span
          className={cn(
            'size-2 rounded-full',
            suspended ? 'bg-err' : 'bg-warn',
          )}
        />
        <h3 className="font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">
          {group.total} 个{suspended ? '' : ' · 含透支中'}
        </span>
        <Link
          className="ml-auto whitespace-nowrap text-xs text-primary"
          to="/admin/tenants"
          search={suspended ? { status: 'suspended' } : {}}
        >
          全部 ›
        </Link>
      </div>
      {group.items.map((t) => (
        <Link
          key={t.id}
          to="/admin/tenants/$tenantId"
          params={{ tenantId: t.id }}
          className="flex min-w-0 items-center gap-3 border-b px-4 py-3 last:border-0 hover:bg-muted"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{t.name}</span>
            <span className="block text-xs text-muted-foreground">
              {t.code} · {t.currency}
            </span>
          </span>
          <StatusTag status={healthStatus[t.health]} />
          <Money
            value={{ currency: t.currency, amount: t.balance }}
            className={cn(
              'whitespace-nowrap font-medium',
              t.health === 'low_balance' && 'text-warn',
            )}
          />
          <span className="text-muted-foreground">›</span>
        </Link>
      ))}
    </div>
  );
}
function CurrencyLines({
  values,
  warning = false,
}: {
  values: { CNY: string; USD: string };
  warning?: boolean;
}) {
  return (
    <div
      className={cn(
        'mt-2 space-y-1 text-lg font-semibold tabular-nums',
        warning && 'text-warn',
      )}
    >
      {(['CNY', 'USD'] as const).map((currency) => (
        <div
          key={currency}
          className="flex items-baseline justify-between gap-1"
        >
          <span className="whitespace-nowrap">
            {formatMoney({ currency, amount: values[currency] })}
          </span>
          <span className="text-xs font-normal text-muted-foreground">
            {currency}
          </span>
        </div>
      ))}
    </div>
  );
}
export function AdminHome({ identity }: { identity: Identity }) {
  const [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY');
  const query = useQuery({
    ...apiQuery('adminOverview'),
    refetchInterval: 60_000,
  });
  const home = query.data;
  const attention = home?.attention;
  const attentionCount = attention
    ? [
        attention.suspended.total,
        attention.lowBalance.total,
        attention.unassigned.pending ? 1 : 0,
        attention.alerts.last24h ? 1 : 0,
      ].reduce((a, b) => a + b, 0)
    : 0;
  const total =
    home?.dailySpend
      .reduce((sum, day) => sum.plus(day[currency]), new Decimal(0))
      .toFixed() ?? '0';
  return (
    <AppShell identity={identity} title="概览" crumb="概览" activeNav="概览">
      <PageBody
        title="概览"
        meta={
          home
            ? `数据截至 ${formatDateTime(home.asOf)} · 每分钟刷新`
            : '加载中…'
        }
      >
        {query.isError ? (
          <LoadError
            error={query.error}
            retrying={query.isFetching}
            onRetry={() => void query.refetch()}
          />
        ) : !home ? (
          <p>加载中…</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <section className="min-w-0 rounded-xl border bg-card p-4">
                <div className="text-sm text-muted-foreground">租户总数</div>
                <div className="mt-2 text-xl font-semibold">
                  {home.metrics.tenantCount}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  含已停用
                </div>
              </section>
              <section className="min-w-0 rounded-xl border bg-card p-4">
                <div className="text-sm text-muted-foreground">
                  今日通话分钟
                </div>
                <div className="mt-2 text-xl font-semibold tabular-nums">
                  {home.metrics.todayCallMinutes}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">分钟</div>
              </section>
              {(
                [
                  ['今日消费', home.metrics.todaySpend],
                  ['本月消费', home.metrics.monthSpend],
                  ['待收款总额', home.metrics.pendingReceivable],
                ] as const
              ).map(([label, value]) => (
                <section
                  key={label}
                  className={cn(
                    'min-w-0 rounded-xl border bg-card p-4',
                    label === '待收款总额' && 'border-warn-border bg-warn-soft',
                  )}
                >
                  <div className="text-sm text-muted-foreground">{label}</div>
                  <CurrencyLines
                    values={value}
                    warning={label === '待收款总额'}
                  />
                </section>
              ))}
              <section
                className={cn(
                  'min-w-0 rounded-xl border bg-card p-4',
                  home.metrics.suspendedTenants > 0 &&
                    'border-err-border bg-err-soft',
                )}
              >
                <div className="text-sm text-muted-foreground">已停机租户</div>
                <div
                  className={cn(
                    'mt-2 text-xl font-semibold',
                    home.metrics.suspendedTenants > 0 && 'text-err',
                  )}
                >
                  {home.metrics.suspendedTenants}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {home.metrics.suspendedTenants > 0 ? '个' : '没有因余额停机'}
                </div>
              </section>
            </div>
            <section>
              <div className="mb-3 flex flex-wrap items-baseline gap-2">
                <h2 className="text-base font-semibold">需要关注</h2>
                {attentionCount ? (
                  <span className="text-sm text-muted-foreground">
                    {attentionCount} 项 · 点击查看详情
                  </span>
                ) : null}
              </div>
              {!attentionCount ? (
                <div className="rounded-xl border border-ok-border bg-ok-soft p-5">
                  <strong className="text-ok">
                    <span aria-hidden="true">✓ </span>
                    <span>一切正常</span>
                  </strong>
                  <p className="mt-1 text-sm">
                    没有已停机或余额不足的租户，没有未归属话单，最近 24
                    小时没有系统告警。
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-3 min-[1200px]:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
                  {home.attention.suspended.total ||
                  home.attention.lowBalance.total ? (
                    <div className="min-w-0 overflow-hidden rounded-xl border bg-card">
                      <TenantAttention
                        title="已停机租户"
                        group={home.attention.suspended}
                        suspended
                      />
                      <TenantAttention
                        title="余额不足租户"
                        group={home.attention.lowBalance}
                      />
                    </div>
                  ) : null}
                  <div className="grid min-w-0 grid-cols-1 content-start gap-3">
                    {home.attention.unassigned.pending > 0 ? (
                      <Link
                        to="/admin/unassigned"
                        className="rounded-xl border border-warn-border bg-warn-soft p-4"
                      >
                        <div className="flex items-center gap-2 font-semibold">
                          <span className="size-2 rounded-full bg-warn" />
                          未归属话单 <span className="ml-auto">›</span>
                        </div>
                        <p className="mt-2 text-2xl font-semibold tabular-nums text-warn">
                          {home.attention.unassigned.pending}{' '}
                          <span className="text-sm font-normal">条待处理</span>
                        </p>
                      </Link>
                    ) : null}
                    {home.attention.alerts.last24h > 0 ? (
                      <div className="rounded-xl border border-err-border bg-card">
                        <Link
                          to="/admin/system-alerts"
                          search={{ window: '24h' }}
                          className="flex items-center gap-2 border-b p-4 font-semibold"
                        >
                          <span className="size-2 rounded-full bg-err" />
                          系统告警{' '}
                          <span className="text-xs font-normal text-muted-foreground">
                            最近 24 小时 · {home.attention.alerts.last24h} 条
                          </span>
                          <span className="ml-auto">›</span>
                        </Link>
                        {home.attention.alerts.items.map((a) => (
                          <Link
                            key={a.id}
                            to="/admin/system-alerts"
                            search={{ window: '24h' }}
                            className="flex min-w-0 items-center gap-2 border-b px-4 py-3 last:border-0 hover:bg-muted"
                          >
                            <Badge
                              variant={a.status === 'open' ? 'error' : 'off'}
                            >
                              {a.kindLabel}
                            </Badge>
                            <span className="min-w-0 flex-1 truncate text-sm">
                              {a.description}
                            </span>
                            <span>›</span>
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              )}
            </section>
            <section className="rounded-xl border bg-card p-4 md:p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold">最近 30 天每日消费</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {home.dailySpend[0]?.date} 至 {home.dailySpend.at(-1)?.date}{' '}
                    · 所有 {currency} 租户合计
                  </p>
                </div>
                <div className="flex items-center gap-4">
                  <div className="text-right">
                    <span className="block text-xs text-muted-foreground">
                      合计
                    </span>
                    <strong className="whitespace-nowrap tabular-nums">
                      {formatMoney({ currency, amount: total })}
                    </strong>
                  </div>
                  <Segmented
                    label="消费币种"
                    options={[
                      { value: 'CNY', label: 'CNY' },
                      { value: 'USD', label: 'USD' },
                    ]}
                    value={currency}
                    onChange={setCurrency}
                  />
                </div>
              </div>
              <DailyChart
                currency={currency}
                days={home.dailySpend.map((day) => ({
                  date: day.date,
                  spend: day[currency],
                }))}
              />
            </section>
          </>
        )}
      </PageBody>
    </AppShell>
  );
}
