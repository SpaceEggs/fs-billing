import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import type {
  AdminTenantDetailResponse,
  AdminTenantSummary,
  AdminTenantsResponse,
  Identity,
} from '@fs-billing/shared';
import {
  AppShell,
  mobileBarButtonClass,
  PageBody,
} from '../../components/app-shell';
import { BalanceDialog } from '../../components/admin/balance-dialog';
import {
  TenantStatusDialog,
  type StatusChangeResult,
} from '../../components/admin/tenant-status-dialog';
import { TenantStatus } from '../../components/admin/tenant-status';
import { Money } from '../../components/data-format';
import { QueryError, RefreshError } from '../../components/query-error';
import { Button, buttonVariants } from '../../components/ui/button';
import { ModalDialog } from '../../components/ui/dialog';
import { apiQuery } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import {
  tenantTabs,
  type TenantDetailSearch,
  type TenantTab,
} from '../../lib/admin-search';
import { CdrsTab } from './tenant-tabs/cdrs-tab';
import { LedgerTab } from './tenant-tabs/ledger-tab';
import { OverviewTab } from './tenant-tabs/overview-tab';
import { PortalTab } from './tenant-tabs/portal-tab';
import { RatesTab } from './tenant-tabs/rates-tab';
import { SettingsTab } from './tenant-tabs/settings-tab';
import { StatementsTab } from './tenant-tabs/statements-tab';
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

/** 手机版标题（稿 3a）：名称、状态、币种与可用额度一行，右侧余额；透支额度与待收款只在电脑版卡片里。 */
function MobileSummary({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const money = (amount: string) => ({ currency: tenant.currency, amount });
  return (
    <section
      aria-label="余额概要"
      className="flex items-center justify-between gap-3 tabular-nums md:hidden"
    >
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-base font-semibold">{tenant.name}</span>
        <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <TenantStatus
            health={tenant.health}
            settingsConfigured={tenant.settingsConfigured}
            className="h-5 px-[7px] text-[11px]"
          />
          <span>
            {tenant.currency} · 可用{' '}
            <Money value={money(tenant.availableBalance)} tone="plain" />
          </span>
        </span>
      </div>
      <span className="flex shrink-0 flex-col items-end">
        <span className="sr-only">当前余额</span>
        <Money
          value={money(tenant.balance)}
          className="text-[22px] font-semibold"
        />
      </span>
    </section>
  );
}

/** 手机版 ⋯：底部面板列出停用/启用与编辑；从面板打开的对话框关闭后焦点回到 ⋯。 */
function MobileActions({
  tenant,
  onStatus,
}: {
  tenant: AdminTenantDetailResponse;
  onStatus: () => void;
}) {
  const [open, setOpen] = useState(false);
  const disabled = tenant.status === 'disabled';
  const title = `${tenant.code} 的操作`;
  return (
    <>
      <button
        type="button"
        aria-label="租户操作"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
        className={mobileBarButtonClass}
      >
        ⋯
      </button>
      <ModalDialog open={open} onOpenChange={setOpen} title={title}>
        <span className="pb-1 text-[15px] font-semibold">{title}</span>
        <div className="flex flex-col">
          <Button
            variant="ghost"
            className={cn(
              'h-12 justify-start border-b border-border px-0 text-base font-normal',
              disabled ? 'text-primary' : 'text-neg',
            )}
            onClick={() => {
              setOpen(false);
              onStatus();
            }}
          >
            {disabled ? '启用' : '停用'}
          </Button>
          <Link
            to="/admin/tenants/$tenantId/edit"
            params={{ tenantId: tenant.id }}
            className="flex h-12 items-center text-base"
          >
            编辑
          </Link>
        </div>
      </ModalDialog>
    </>
  );
}

function BalanceCards({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const money = (amount: string) => ({ currency: tenant.currency, amount });
  return (
    <div className="hidden rounded-xl border border-border tabular-nums md:grid md:grid-cols-[1.4fr_1fr_1fr_1fr] print:hidden">
      <section
        aria-label="当前余额"
        className="flex flex-col gap-1.5 border-r border-border px-6 py-5"
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
      <section className="flex flex-col gap-1.5 border-r border-border px-6 py-5">
        <span className="text-[13px] text-muted-foreground">可用额度</span>
        <Money
          value={money(tenant.availableBalance)}
          className="text-[22px] font-semibold"
        />
        <span className="text-xs text-muted-foreground">余额 + 透支额度</span>
      </section>
      <section className="flex flex-col gap-1.5 px-6 py-5">
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

function TabContent({
  tab,
  tenant,
}: {
  tab: TenantTab;
  tenant: AdminTenantDetailResponse;
}) {
  switch (tab) {
    case 'overview':
      return <OverviewTab tenantId={tenant.id} />;
    case 'ledger':
      return <LedgerTab tenantId={tenant.id} />;
    case 'rates':
      return <RatesTab tenant={tenant} />;
    case 'cdrs':
      return <CdrsTab tenant={tenant} />;
    case 'statements':
      return <StatementsTab tenant={tenant} />;
    case 'settings':
      return <SettingsTab tenant={tenant} />;
    case 'portal':
      return (
        <PortalTab
          tenantId={tenant.id}
          tenantDisabled={tenant.status === 'disabled'}
        />
      );
  }
}

/**
 * 标签页链接：余额流水与话单各自的日期范围和筛选随切换保留；余额流水（每页 25 条）与话单（每页 50 条）共用页码键，
 * 进出话单标签页时回到第一页。账单标签页打开的月份（statementMonth）只属于账单标签页，换标签页时清除。
 */
function tabSearch(
  search: Omit<TenantDetailSearch, 'tab'>,
  current: TenantTab,
  target: TenantTab,
): TenantDetailSearch {
  const paged =
    target === current || (target !== 'cdrs' && current !== 'cdrs')
      ? search
      : { ...search, page: undefined };
  // 点当前的账单标签页回到账单列表。
  const next =
    target === current && target !== 'statements'
      ? paged
      : { ...paged, statementMonth: undefined };
  return target === 'overview' ? next : { ...next, tab: target };
}

const statusNotices = {
  disable: {
    changed: '租户已停用，已记入操作日志',
    same: '租户已是停用状态，没有变更',
  },
  enable: {
    changed: '租户已启用，已记入操作日志',
    same: '租户已是启用状态，没有变更',
  },
} as const;

/**
 * 换租户（如浏览器后退到已缓存的另一租户）时整页重新挂载：卸载对话框，
 * 丢弃上一租户未返回的结果（临时密码、余额变动、状态变更），不显示到当前租户下。
 */
export function TenantDetailPage({ identity }: { identity: Identity }) {
  const { tenantId } = useParams({ from: '/admin/tenants/$tenantId' });
  return (
    <TenantDetail key={tenantId} identity={identity} tenantId={tenantId} />
  );
}

/** 租户详情（设计稿第一批 2a/2b、第三批）：标题与操作、余额卡片、标签页。 */
function TenantDetail({
  identity,
  tenantId,
}: {
  identity: Identity;
  tenantId: string;
}) {
  // 余额流水的筛选随标签页切换保留在地址里。
  const { tab = 'overview', ...ledger } = useSearch({
    from: '/admin/tenants/$tenantId',
  });
  const navigate = useNavigate();
  const listed = useListedTenant(tenantId);
  const detail = useQuery(
    apiQuery('adminTenantDetail', { params: { tenantId } }),
  );
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [statusAction, setStatusAction] = useState<'disable' | 'enable' | null>(
    null,
  );
  const [statusResult, setStatusResult] = useState<StatusChangeResult | null>(
    null,
  );
  const tenant = detail.data;
  const code = tenant?.code ?? listed?.code;
  const title = tenant?.name ?? listed?.name ?? '租户详情';
  const disabled = tenant?.status === 'disabled';
  const openStatus = () => {
    setStatusResult(null);
    setStatusAction(disabled ? 'enable' : 'disable');
  };
  return (
    <AppShell
      identity={identity}
      title={code ?? '租户详情'}
      monoTitle={code !== undefined}
      crumb={<Crumb code={code} />}
      activeNav="租户"
      mobileNav={
        <Link
          to="/admin/tenants"
          aria-label="返回租户列表"
          className={mobileBarButtonClass}
        >
          ‹
        </Link>
      }
      mobileActions={
        tenant ? <MobileActions tenant={tenant} onStatus={openStatus} /> : null
      }
    >
      <PageBody
        title={title}
        {...(tenant
          ? {
              badge: (
                <TenantStatus
                  health={tenant.health}
                  settingsConfigured={tenant.settingsConfigured}
                />
              ),
              actions: (
                <div className="flex gap-2 print:hidden">
                  <Button variant="outline" onClick={openStatus}>
                    {disabled ? '启用' : '停用'}
                  </Button>
                  <Link
                    to="/admin/tenants/$tenantId/edit"
                    params={{ tenantId }}
                    className={buttonVariants({ variant: 'outline' })}
                  >
                    编辑
                  </Link>
                  <Button onClick={() => setBalanceOpen(true)}>余额操作</Button>
                </div>
              ),
            }
          : {})}
      >
        {tenant ? (
          <>
            <RefreshError
              title="租户详情刷新失败，余额与状态可能不是最新"
              query={detail}
            />
            <MobileSummary tenant={tenant} />
            <div className="hidden flex-wrap gap-3.5 text-[13px] text-muted-foreground md:flex">
              <span className="font-mono text-foreground">{tenant.code}</span>
              <span>{tenant.currency}</span>
              <span>创建于 {formatDate(tenant.createdAt)}</span>
            </div>
            {statusResult ? (
              <div
                role="status"
                className={cn(
                  'rounded-lg border px-3.5 py-2.5 text-[13px]',
                  statusResult.changed
                    ? 'border-ok-border bg-ok-soft text-ok'
                    : 'border-border bg-muted text-muted-foreground',
                )}
              >
                {
                  statusNotices[statusResult.action][
                    statusResult.changed ? 'changed' : 'same'
                  ]
                }
              </div>
            ) : null}
            <BalanceCards tenant={tenant} />
            <BalanceDialog
              owner={identity.profileId}
              tenant={tenant}
              open={balanceOpen}
              onOpenChange={setBalanceOpen}
              onViewLedger={() => {
                setBalanceOpen(false);
                void navigate({
                  to: '/admin/tenants/$tenantId',
                  params: { tenantId },
                  search: { tab: 'ledger' },
                });
              }}
            />
            <TenantStatusDialog
              tenant={tenant}
              action={statusAction}
              onClose={() => setStatusAction(null)}
              onDone={(result) => {
                setStatusAction(null);
                setStatusResult(result);
              }}
            />
            <nav
              aria-label="租户详情"
              className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 text-sm md:mx-0 md:px-0 print:hidden"
            >
              {tenantTabs.map(({ key, label }) => (
                <Link
                  key={key}
                  to="/admin/tenants/$tenantId"
                  params={{ tenantId }}
                  search={tabSearch(ledger, tab, key)}
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
            <TabContent tab={tab} tenant={tenant} />
            {tab === 'settings' || tab === 'portal' ? null : (
              // 设置标签页底部是自己的保存按钮；门户账号标签页按第三批 3j 稿不放余额操作。
              <div className="sticky bottom-0 -mx-4 -mb-4 border-t border-border bg-background px-4 pt-3 pb-4 md:hidden print:hidden">
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => setBalanceOpen(true)}
                >
                  余额操作
                </Button>
              </div>
            )}
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
