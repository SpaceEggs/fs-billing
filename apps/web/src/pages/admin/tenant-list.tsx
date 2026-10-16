import { useId } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import Decimal from 'decimal.js';
import {
  currencySchema,
  type AdminTenantSummary,
  type Identity,
} from '@fs-billing/shared';
import {
  AppShell,
  mobileBarPrimaryClass,
  PageBody,
} from '../../components/app-shell';
import {
  healthOptions,
  healthStatus,
  TenantStatus,
} from '../../components/admin/tenant-status';
import { Money } from '../../components/data-format';
import {
  ChoiceGrid,
  FilterGroup,
  FilterSheet,
  resultLabel,
} from '../../components/filter-sheet';
import { Pagination } from '../../components/pagination';
import { SearchBox } from '../../components/search-box';
import { QueryError, RefreshError } from '../../components/query-error';
import { statusTags } from '../../components/status-tag';
import { Button, buttonVariants } from '../../components/ui/button';
import { Segmented } from '../../components/ui/segmented';
import { Select } from '../../components/ui/select';
import { apiQuery } from '../../lib/admin-api';
import type { TenantListSearch } from '../../lib/admin-search';
import { cn } from '../../lib/utils';

export const tenantPageSize = 25;

const money = (tenant: AdminTenantSummary, amount: string) => ({
  currency: tenant.currency,
  amount,
});

function withoutPage(search: {
  [Key in keyof TenantListSearch]?: TenantListSearch[Key] | undefined;
}): TenantListSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) => key !== 'page' && value !== undefined,
    ),
  );
}

function useTenantSearch() {
  const search = useSearch({ from: '/admin/tenants' });
  const navigate = useNavigate({ from: '/admin/tenants' });
  const update = (next: TenantListSearch) =>
    void navigate({ search: next, replace: true });
  return { search, update };
}

const statusChoices = [
  { value: undefined, label: '全部状态' },
  ...healthOptions,
] as const;
const currencyChoices = [
  { value: undefined, label: '全部币种' },
  ...currencySchema.options.map((currency) => ({
    value: currency,
    label: currency,
  })),
] as const;

/** 电脑版筛选排成一行；手机版只留搜索框，状态与币种收进「筛选」面板（稿 1b）。 */
function Filters({ total }: { total: number | undefined }) {
  const { search, update } = useTenantSearch();
  const statusId = useId();
  /** 改筛选回到第一页；值为 undefined 表示清除该筛选。 */
  const setFilter = (patch: {
    [Key in keyof TenantListSearch]?: TenantListSearch[Key] | undefined;
  }) => update(withoutPage({ ...search, ...patch }));
  return (
    <div className="flex gap-2 md:items-center md:gap-3">
      <SearchBox
        label="搜索编码或名称"
        value={search.search ?? ''}
        onChange={(value) =>
          setFilter({ search: value === '' ? undefined : value })
        }
        className="min-w-0 flex-1 md:w-[280px] md:flex-none"
      />
      <FilterSheet
        activeCount={[search.status, search.currency].filter(Boolean).length}
        resultLabel={resultLabel(total, '个')}
        onClear={() => setFilter({ status: undefined, currency: undefined })}
      >
        <FilterGroup label="状态">
          {(labelId) => (
            <ChoiceGrid
              labelledBy={labelId}
              options={statusChoices}
              value={search.status}
              onChange={(status) => setFilter({ status })}
            />
          )}
        </FilterGroup>
        <FilterGroup label="币种">
          {() => (
            <Segmented
              label="币种"
              options={currencyChoices}
              value={search.currency}
              onChange={(currency) => setFilter({ currency })}
              className="w-full self-stretch text-[15px]"
            />
          )}
        </FilterGroup>
      </FilterSheet>
      <div className="hidden md:contents">
        <label htmlFor={statusId} className="sr-only">
          状态
        </label>
        <Select
          id={statusId}
          value={search.status ?? ''}
          onChange={(event) => {
            const status = healthOptions.find(
              ({ value }) => value === event.target.value,
            )?.value;
            setFilter({ status });
          }}
          className="w-[150px]"
        >
          {statusChoices.map((option) => (
            <option key={option.value ?? ''} value={option.value ?? ''}>
              {option.label}
            </option>
          ))}
        </Select>
        <Segmented
          label="币种"
          options={currencyChoices}
          value={search.currency}
          onChange={(currency) => setFilter({ currency })}
        />
      </div>
      <span className="hidden flex-1 text-right text-xs text-muted-foreground md:block">
        排序：状态 → 同币种内余额从低到高
      </span>
    </div>
  );
}

function filterSummary(search: TenantListSearch) {
  return [
    search.search ? `搜索「${search.search}」` : null,
    search.status
      ? `状态：${statusTags[healthStatus[search.status]].label}`
      : null,
    search.currency ? `币种：${search.currency}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function NewTenantLink({ className }: { className?: string }) {
  return (
    <Link
      to="/admin/tenants/new"
      className={cn(buttonVariants({ size: 'md' }), className)}
    >
      ＋ 新建租户
    </Link>
  );
}

function EmptyState({ search }: { search: TenantListSearch }) {
  const { update } = useTenantSearch();
  const summary = filterSummary(search);
  if (!summary)
    return (
      <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-8 text-center">
        <span className="text-[15px] font-semibold">还没有租户</span>
        <span className="text-[13px] text-muted-foreground">
          新建租户后，在 FreeSWITCH 中设置相同的 billing_tenant
        </span>
        <NewTenantLink />
      </div>
    );
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-7 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground"
      >
        ⌕
      </span>
      <span className="text-[15px] font-semibold">没有符合条件的租户</span>
      <span className="text-[13px] text-muted-foreground">{summary}</span>
      <Button variant="outline" size="sm" onClick={() => update({})}>
        清除筛选
      </Button>
    </div>
  );
}

function LoadingRows() {
  return (
    <div
      aria-busy
      aria-label="租户列表加载中"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="border-b border-border px-3.5 py-2.5 text-xs text-muted-foreground">
        加载中
      </div>
      {[1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="grid h-11 grid-cols-[1fr_2.4fr_1fr_1.2fr] items-center gap-3.5 border-b border-border px-3.5 last:border-b-0"
        >
          <span className="h-2.5 w-4/5 rounded bg-skeleton" />
          <span className="h-2.5 w-[70%] rounded bg-skeleton" />
          <span className="h-[18px] w-[70%] rounded-md bg-skeleton" />
          <span className="h-2.5 w-[65%] justify-self-end rounded bg-skeleton" />
        </div>
      ))}
    </div>
  );
}

function PendingReceivable({ tenant }: { tenant: AdminTenantSummary }) {
  if (new Decimal(tenant.pendingReceivable).isZero())
    return <span className="text-muted-foreground">—</span>;
  return (
    <Money
      value={money(tenant, tenant.pendingReceivable)}
      tone="plain"
      className="font-semibold text-warn"
    />
  );
}

function TenantTable({ items }: { items: AdminTenantSummary[] }) {
  const navigate = useNavigate();
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <table className="w-full border-collapse text-[13px] whitespace-nowrap">
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">租户编码</th>
            <th className="px-3 py-2.5 text-left font-medium">名称</th>
            <th className="px-3 py-2.5 text-left font-medium">币种</th>
            <th className="px-3 py-2.5 text-left font-medium">状态</th>
            <th className="px-3 py-2.5 text-right font-medium">当前余额</th>
            <th className="px-3 py-2.5 text-right font-medium">透支额度</th>
            <th className="px-3 py-2.5 text-right font-medium">本月消费</th>
            <th className="px-3 py-2.5 text-right font-medium">待收款</th>
            <th className="px-4 py-2.5">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {items.map((tenant) => (
            <tr
              key={tenant.id}
              onClick={() =>
                void navigate({
                  to: '/admin/tenants/$tenantId',
                  params: { tenantId: tenant.id },
                })
              }
              className={cn(
                'cursor-pointer border-t border-border hover:bg-row-hover',
                tenant.status === 'disabled' && 'text-muted-foreground',
              )}
            >
              <td className="px-4 py-2.5 font-mono text-[12.5px] font-medium">
                <Link
                  to="/admin/tenants/$tenantId"
                  params={{ tenantId: tenant.id }}
                  onClick={(event) => event.stopPropagation()}
                  className="rounded outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
                >
                  {tenant.code}
                </Link>
              </td>
              <td className="px-3 py-2.5 text-sm">{tenant.name}</td>
              <td className="px-3 py-2.5 text-muted-foreground">
                {tenant.currency}
              </td>
              <td className="px-3 py-2.5">
                <TenantStatus
                  health={tenant.health}
                  settingsConfigured={tenant.settingsConfigured}
                />
              </td>
              <td className="px-3 py-2.5 text-right font-semibold">
                <Money value={money(tenant, tenant.balance)} />
              </td>
              <td className="px-3 py-2.5 text-right text-muted-foreground">
                <Money
                  value={money(tenant, tenant.overdraftLimit)}
                  tone="plain"
                />
              </td>
              <td className="px-3 py-2.5 text-right">
                <Money
                  value={money(tenant, tenant.monthConsumption)}
                  tone="plain"
                />
              </td>
              <td className="px-3 py-2.5 text-right">
                <PendingReceivable tenant={tenant} />
              </td>
              <td className="px-4 py-1.5 text-right">
                <Link
                  to="/admin/tenants/$tenantId"
                  params={{ tenantId: tenant.id }}
                  search={{ tab: 'ledger' }}
                  onClick={(event) => event.stopPropagation()}
                  aria-label={`为 ${tenant.code} 充值`}
                  className={cn(
                    buttonVariants({ variant: 'outline', size: 'sm' }),
                    'h-[30px] hover:border-primary hover:bg-transparent hover:text-primary',
                  )}
                >
                  充值
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TenantCards({ items }: { items: AdminTenantSummary[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((tenant) => (
        <li key={tenant.id}>
          <Link
            to="/admin/tenants/$tenantId"
            params={{ tenantId: tenant.id }}
            className={cn(
              'flex items-center justify-between gap-2.5 rounded-[10px] border border-border px-3.5 py-3',
              tenant.status === 'disabled' && 'text-muted-foreground',
            )}
          >
            <span className="flex min-w-0 flex-col gap-[5px]">
              <span className="truncate text-[15px] font-medium">
                {tenant.name}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">
                  {tenant.code}
                </span>
                <TenantStatus
                  health={tenant.health}
                  settingsConfigured={tenant.settingsConfigured}
                  className="h-5 px-1.5 text-[11px]"
                />
              </span>
            </span>
            <Money
              value={money(tenant, tenant.balance)}
              className="text-base font-semibold whitespace-nowrap"
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 租户列表（第一批 1a/1b/1c）：筛选写入地址，排序由服务端按状态、币种、余额。 */
export function TenantListPage({ identity }: { identity: Identity }) {
  const { search, update } = useTenantSearch();
  const page = search.page ?? 1;
  const tenants = useQuery({
    ...apiQuery('adminTenants', {
      query: { ...search, page, pageSize: tenantPageSize },
    }),
    placeholderData: keepPreviousData,
  });
  const data = tenants.data;
  return (
    <AppShell
      identity={identity}
      title="租户"
      crumb="租户"
      activeNav="租户"
      mobileActions={
        <Link
          to="/admin/tenants/new"
          aria-label="新建租户"
          className={mobileBarPrimaryClass}
        >
          ＋
        </Link>
      }
    >
      <PageBody
        title="租户"
        meta={data ? `共 ${data.pagination.total} 个` : undefined}
        actions={<NewTenantLink />}
      >
        <Filters
          total={tenants.isPlaceholderData ? undefined : data?.pagination.total}
        />
        <RefreshError
          title="租户列表刷新失败，列表可能不是最新"
          query={tenants}
        />
        {tenants.isError && !data ? (
          <QueryError
            title="租户列表加载失败"
            error={tenants.error}
            retrying={tenants.isFetching}
            onRetry={() => void tenants.refetch()}
          />
        ) : !data ? (
          <LoadingRows />
        ) : data.items.length === 0 ? (
          <EmptyState search={search} />
        ) : (
          <>
            <TenantTable items={data.items} />
            <TenantCards items={data.items} />
            <Pagination
              page={page}
              pageSize={tenantPageSize}
              rowCount={data.pagination.total}
              onPage={(next) =>
                update(
                  next > 1
                    ? { ...withoutPage(search), page: next }
                    : withoutPage(search),
                )
              }
            />
          </>
        )}
      </PageBody>
    </AppShell>
  );
}
