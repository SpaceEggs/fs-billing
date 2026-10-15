import { useEffect, useId, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import Decimal from 'decimal.js';
import {
  currencySchema,
  type AdminTenantSummary,
  type Identity,
} from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import {
  healthOptions,
  healthStatus,
  TenantStatus,
} from '../../components/admin/tenant-status';
import { Money } from '../../components/data-format';
import { QueryError } from '../../components/query-error';
import { statusTags } from '../../components/status-tag';
import { Button, buttonVariants } from '../../components/ui/button';
import { apiQuery } from '../../lib/admin-api';
import type { TenantListSearch } from '../../lib/admin-search';
import { cn } from '../../lib/utils';

export const tenantPageSize = 25;
const searchDelayMs = 300;

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

/** 搜索框输入后稍等再写入地址，避免每个字都请求一次。 */
function SearchBox({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = setTimeout(() => latest.current(draft.trim()), searchDelayMs);
    return () => clearTimeout(timer);
  }, [draft, value]);
  return (
    <input
      type="search"
      aria-label="搜索编码或名称"
      placeholder="搜索编码或名称"
      maxLength={200}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      className={cn(
        'h-11 rounded-lg border border-input bg-transparent px-3 text-base outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9 md:text-sm',
        className,
      )}
    />
  );
}

function Filters() {
  const { search, update } = useTenantSearch();
  const statusId = useId();
  /** 改筛选回到第一页；值为 undefined 表示清除该筛选。 */
  const setFilter = (patch: {
    [Key in keyof TenantListSearch]?: TenantListSearch[Key] | undefined;
  }) => update(withoutPage({ ...search, ...patch }));
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <SearchBox
        value={search.search ?? ''}
        onChange={(value) =>
          setFilter({ search: value === '' ? undefined : value })
        }
        className="md:w-[280px]"
      />
      <div className="flex items-center gap-2 md:contents">
        <label htmlFor={statusId} className="sr-only">
          状态
        </label>
        <select
          id={statusId}
          value={search.status ?? ''}
          onChange={(event) => {
            const status = healthOptions.find(
              ({ value }) => value === event.target.value,
            )?.value;
            setFilter({ status });
          }}
          className="h-11 flex-1 rounded-lg border border-input bg-background px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9 md:w-[150px] md:flex-none md:text-sm"
        >
          <option value="">全部状态</option>
          {healthOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <div
          role="group"
          aria-label="币种"
          className="flex h-11 gap-0.5 rounded-lg bg-muted p-[3px] text-[13px] md:h-9"
        >
          {([undefined, ...currencySchema.options] as const).map((currency) => {
            const selected = search.currency === currency;
            return (
              <button
                key={currency ?? 'all'}
                type="button"
                aria-pressed={selected}
                onClick={() => setFilter({ currency })}
                className={cn(
                  'rounded-md px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
                  selected
                    ? 'bg-background font-medium shadow-[0_1px_2px_rgba(0,0,0,.1)]'
                    : 'text-muted-foreground',
                )}
              >
                {currency ?? '全部币种'}
              </button>
            );
          })}
        </div>
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

function Pagination({
  page,
  rowCount,
  onPage,
}: {
  page: number;
  rowCount: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(rowCount / tenantPageSize));
  if (pages <= 1) return null;
  return (
    <nav
      aria-label="分页"
      className="flex items-center justify-end gap-3 text-[13px] text-muted-foreground"
    >
      <span>
        第 {page} / {pages} 页
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={page >= pages}
        onClick={() => onPage(page + 1)}
      >
        下一页
      </Button>
    </nav>
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
    <AppShell identity={identity} title="租户" crumb="租户" activeNav="租户">
      <PageBody
        title="租户"
        meta={data ? `共 ${data.pagination.total} 个` : undefined}
        actions={<NewTenantLink className="w-full md:w-auto" />}
      >
        <Filters />
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
