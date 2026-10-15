import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useSearch } from '@tanstack/react-router';
import type {
  AdminTenantDetailResponse,
  AdminTenantSummary,
  AdminTenantsResponse,
  Identity,
} from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { TenantStatus } from '../../components/admin/tenant-status';
import { Money } from '../../components/data-format';
import { QueryError } from '../../components/query-error';
import { apiQuery } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import { tenantTabs } from '../../lib/admin-search';
import { formatDate } from '../../lib/format';
import { cn } from '../../lib/utils';

/** 列表已加载过该租户时，详情失败仍能显示编码与名称，并判断是否缺少提醒设置。 */
function useListedTenant(tenantId: string) {
  const queryClient = useQueryClient();
  for (const [, data] of queryClient.getQueriesData<AdminTenantsResponse>({
    queryKey: ['api', 'adminTenants'],
  })) {
    const found = data?.items.find((item) => item.id === tenantId);
    if (found) return found;
  }
  return null;
}

function Crumb({ code }: { code: string | undefined }) {
  return (
    <>
      <Link to="/admin/tenants" className="text-primary">
        租户
      </Link>
      {code ? ` / ${code}` : null}
    </>
  );
}

function BalanceCards({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const money = (amount: string) => ({ currency: tenant.currency, amount });
  return (
    <div className="grid grid-cols-2 rounded-xl border border-border tabular-nums md:grid-cols-[1.4fr_1fr_1fr_1fr]">
      <section
        aria-label="当前余额"
        className="col-span-2 flex flex-col gap-1.5 border-b border-border px-6 py-5 md:col-span-1 md:border-r md:border-b-0"
      >
        <span className="text-[13px] text-muted-foreground">当前余额</span>
        <Money
          value={money(tenant.balance)}
          className="text-[36px] leading-[1.1] font-semibold tracking-[-0.02em]"
        />
      </section>
      <section className="flex flex-col gap-1.5 border-r border-border px-6 py-5">
        <span className="text-[13px] text-muted-foreground">透支额度</span>
        <Money
          value={money(tenant.overdraftLimit)}
          tone="plain"
          className="text-[22px] font-semibold"
        />
        <span className="text-xs text-muted-foreground">
          提醒阈值{' '}
          <Money
            value={money(tenant.settings.lowBalanceThreshold)}
            tone="plain"
          />
        </span>
      </section>
      <section className="flex flex-col gap-1.5 px-6 py-5 md:border-r md:border-border">
        <span className="text-[13px] text-muted-foreground">可用额度</span>
        <Money
          value={money(tenant.availableBalance)}
          className="text-[22px] font-semibold"
        />
        <span className="text-xs text-muted-foreground">余额 + 透支额度</span>
      </section>
      <section className="col-span-2 flex flex-col gap-1.5 border-t border-border px-6 py-5 md:col-span-1 md:border-t-0">
        <span className="text-[13px] text-muted-foreground">待收款</span>
        <Money
          value={money(tenant.pendingReceivable)}
          tone="plain"
          className="text-[22px] font-semibold text-warn"
        />
      </section>
    </div>
  );
}

function DetailError({
  listed,
  error,
  retrying,
  onRetry,
}: {
  listed: AdminTenantSummary | null;
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}) {
  if (
    listed &&
    !listed.settingsConfigured &&
    apiProblem(error).kind === 'unavailable'
  )
    return (
      <div
        role="alert"
        className="flex flex-col gap-1 rounded-xl border border-unv-border bg-unv-soft px-[18px] py-4 text-unv"
      >
        <span className="text-sm font-semibold">
          该租户缺少余额提醒设置，暂时无法查看详情
        </span>
        <span className="text-[13px]">
          这是开户早于提醒设置的存量租户。请联系技术人员补齐设置后再查看；租户本身的呼叫与计费不受影响。
        </span>
      </div>
    );
  return (
    <QueryError
      title="租户详情加载失败"
      error={error}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}

/** 租户详情外壳：标题、余额卡片与标签页；各标签页内容随后续交付。 */
export function TenantDetailPage({ identity }: { identity: Identity }) {
  const { tenantId } = useParams({ from: '/admin/tenants/$tenantId' });
  const { tab = 'overview' } = useSearch({ from: '/admin/tenants/$tenantId' });
  const listed = useListedTenant(tenantId);
  const detail = useQuery(
    apiQuery('adminTenantDetail', { params: { tenantId } }),
  );
  const tenant = detail.data;
  const code = tenant?.code ?? listed?.code;
  const title = tenant?.name ?? listed?.name ?? '租户详情';
  return (
    <AppShell
      identity={identity}
      title={code ?? '租户详情'}
      crumb={<Crumb code={code} />}
      activeNav="租户"
    >
      <PageBody title={title}>
        {tenant ? (
          <>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2.5">
                <span className="text-lg font-semibold md:hidden">
                  {tenant.name}
                </span>
                <TenantStatus
                  health={tenant.health}
                  settingsConfigured={tenant.settingsConfigured}
                />
              </div>
              <div className="flex flex-wrap gap-3.5 text-[13px] text-muted-foreground">
                <span className="font-mono text-foreground">{tenant.code}</span>
                <span>{tenant.currency}</span>
                <span>创建于 {formatDate(tenant.createdAt)}</span>
              </div>
            </div>
            <BalanceCards tenant={tenant} />
            <nav
              aria-label="租户详情"
              className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 text-sm md:mx-0 md:px-0"
            >
              {tenantTabs.map(({ key, label }) => (
                <Link
                  key={key}
                  to="/admin/tenants/$tenantId"
                  params={{ tenantId }}
                  search={key === 'overview' ? {} : { tab: key }}
                  aria-current={key === tab ? 'page' : undefined}
                  className={cn(
                    '-mb-px border-b-2 px-3 py-2.5 whitespace-nowrap',
                    key === tab
                      ? 'border-primary font-semibold text-foreground'
                      : 'border-transparent text-muted-foreground',
                  )}
                >
                  {label}
                </Link>
              ))}
            </nav>
            <p className="m-0 text-sm text-muted-foreground">
              该标签页即将开放。
            </p>
          </>
        ) : detail.isError ? (
          <DetailError
            listed={listed}
            error={detail.error}
            retrying={detail.isFetching}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <div
            aria-busy
            aria-label="租户详情加载中"
            className="h-[120px] animate-pulse rounded-xl bg-skeleton"
          />
        )}
      </PageBody>
    </AppShell>
  );
}
