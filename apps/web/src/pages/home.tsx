import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { Identity } from '@fs-billing/shared';
import { AppShell, PageBody } from '../components/app-shell';
import { DailyChart } from '../components/daily-spend-chart';
import { LoadError } from '../components/load-error';
import { apiQuery } from '../lib/admin-api';
import { formatDateTime, formatMoney } from '../lib/format';

export function AdminHome({ identity }: { identity: Identity }) {
  const [currency, setCurrency] = useState<'CNY' | 'USD'>('CNY');
  const query = useQuery({
    ...apiQuery('adminOverview'),
    refetchInterval: 60_000,
  });
  const home = query.data;
  const amounts = (value: { CNY: string; USD: string }) =>
    `${formatMoney({ currency: 'CNY', amount: value.CNY })} / ${formatMoney({ currency: 'USD', amount: value.USD })}`;
  const attention = home?.attention;
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
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
              {[
                ['租户总数', String(home.metrics.tenantCount), '含已停用'],
                ['今日通话分钟', home.metrics.todayCallMinutes, '分钟'],
                ['今日消费', amounts(home.metrics.todaySpend), 'CNY / USD'],
                ['本月消费', amounts(home.metrics.monthSpend), 'CNY / USD'],
                [
                  '待收款总额',
                  amounts(home.metrics.pendingReceivable),
                  'CNY / USD',
                ],
                ['已停机租户', String(home.metrics.suspendedTenants), '个'],
              ].map(([label, value, note]) => (
                <section key={label} className="rounded-xl border bg-card p-4">
                  <div className="text-sm text-muted-foreground">{label}</div>
                  <div className="mt-2 text-lg font-semibold tabular-nums">
                    {value}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {note}
                  </div>
                </section>
              ))}
            </div>
            <section className="rounded-xl border bg-card p-5">
              <h2 className="mb-4 text-base font-semibold">需要关注</h2>
              {attention &&
              [
                attention.suspended.total,
                attention.lowBalance.total,
                attention.unassigned.pending,
                attention.alerts.last24h,
              ].every((count) => count === 0) ? (
                <p>一切正常</p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {attention && attention.suspended.total > 0 ? (
                    <div>
                      <Link
                        to="/admin/tenants"
                        search={{ status: 'suspended' }}
                        className="font-medium text-primary"
                      >
                        已停机 {attention.suspended.total} 个
                      </Link>
                      {attention.suspended.items.map((t) => (
                        <div key={t.id}>
                          <Link
                            to="/admin/tenants/$tenantId"
                            params={{ tenantId: t.id }}
                          >
                            {t.code} · {t.name}
                          </Link>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {attention && attention.lowBalance.total > 0 ? (
                    <div>
                      <Link
                        to="/admin/tenants"
                        className="font-medium text-primary"
                      >
                        余额不足 {attention.lowBalance.total} 个 · 含透支中
                      </Link>
                      {attention.lowBalance.items.map((t) => (
                        <div key={t.id}>
                          <Link
                            to="/admin/tenants/$tenantId"
                            params={{ tenantId: t.id }}
                          >
                            {t.code} · {t.name}
                          </Link>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {attention && attention.unassigned.pending > 0 ? (
                    <Link to="/admin/unassigned" className="text-primary">
                      未归属话单 {attention.unassigned.pending} 条
                    </Link>
                  ) : null}
                  {attention && attention.alerts.last24h > 0 ? (
                    <div>
                      <Link to="/admin/system-alerts" className="text-primary">
                        系统告警 · 最近 24 小时 {attention.alerts.last24h} 条 ·
                        进行中 {attention.alerts.open}
                      </Link>
                      {attention.alerts.items.map((a) => (
                        <div key={a.id}>
                          {a.kindLabel} · {a.description}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </section>
            <section className="rounded-xl border bg-card p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-base font-semibold">最近 30 天每日消费</h2>
                <div>
                  {(['CNY', 'USD'] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-pressed={currency === c}
                      className="rounded px-3 py-1 aria-pressed:bg-muted"
                      onClick={() => setCurrency(c)}
                    >
                      {c}
                    </button>
                  ))}
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
