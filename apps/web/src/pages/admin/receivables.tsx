import { useEffect, useRef, useState } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  currencySchema,
  type AdminReceivable,
  type Identity,
} from '@fs-billing/shared';
import {
  ConfirmPaymentDialog,
  receivableMoney,
} from '../../components/admin/confirm-payment-dialog';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateTime, Money } from '../../components/data-format';
import { Pagination } from '../../components/pagination';
import { QueryError } from '../../components/query-error';
import { SearchBox } from '../../components/search-box';
import { Button } from '../../components/ui/button';
import { apiKey, invalidateTenant, send } from '../../lib/admin-api';
import type { ReceivablesSearch } from '../../lib/admin-search';
import { formatMoney } from '../../lib/format';
import { sequencedRequests, visibleTotals } from '../../lib/receivables';
import { cn } from '../../lib/utils';

export const receivablePageSize = 25;

type SearchPatch = {
  [Key in keyof ReceivablesSearch]?: ReceivablesSearch[Key] | undefined;
};

function withoutPage(search: SearchPatch): ReceivablesSearch {
  return Object.fromEntries(
    Object.entries(search).filter(
      ([key, value]) => key !== 'page' && value !== undefined,
    ),
  );
}

function useReceivablesSearch() {
  const search = useSearch({ from: '/admin/receivables' });
  const navigate = useNavigate({ from: '/admin/receivables' });
  const update = (next: ReceivablesSearch) =>
    void navigate({ search: next, replace: true });
  /** 改搜索或币种回到第一页；值为 undefined 表示清除。 */
  const setFilter = (patch: SearchPatch) =>
    update(withoutPage({ ...search, ...patch }));
  return { search, update, setFilter };
}

function Filters() {
  const { search, setFilter } = useReceivablesSearch();
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <SearchBox
        label="搜索租户"
        value={search.search ?? ''}
        onChange={(value) =>
          setFilter({ search: value === '' ? undefined : value })
        }
        className="md:w-[260px]"
      />
      <div
        role="group"
        aria-label="币种"
        className="flex h-11 gap-0.5 self-start rounded-lg bg-muted p-[3px] text-[13px] md:h-9"
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
  );
}

const zeroTotals = { CNY: '0', USD: '0' };

/**
 * 分币种合计（6a/6b）：按筛选后的全部结果统计，不只当前页；CNY 与 USD 不相加。
 * `totals` 为 null 表示新筛选的结果还没到：上一次响应的合计属于旧筛选，不能当作当前合计显示。
 */
function Totals({
  totals,
  currency,
}: {
  totals: Parameters<typeof visibleTotals>[0] | null;
  currency: ReceivablesSearch['currency'];
}) {
  return (
    <ul
      aria-label="待收款合计"
      aria-busy={totals === null}
      className="m-0 grid list-none grid-cols-2 gap-2.5 p-0 tabular-nums md:grid-cols-3 md:gap-4"
    >
      {visibleTotals(totals ?? zeroTotals, currency).map((money) => (
        <li
          key={money.currency}
          aria-label={`待收款总额 ${money.currency}`}
          className="flex flex-col gap-1 rounded-xl border border-border px-3.5 py-3 md:gap-1.5 md:px-5 md:py-[18px]"
        >
          <span className="text-xs text-muted-foreground md:text-[13px]">
            <span className="hidden md:inline">待收款总额 · </span>
            {money.currency}
          </span>
          {totals ? (
            <Money
              value={money}
              tone="plain"
              className="text-xl font-semibold md:text-[28px] md:tracking-[-0.02em]"
            />
          ) : (
            <span className="text-xl font-semibold text-muted-foreground md:text-[28px]">
              加载中
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** 逾期只看接口的 overdue（决定 10：北京时间自然日差超过 30 天）。 */
function AgeDays({ receivable }: { receivable: AdminReceivable }) {
  return (
    <span className={cn(receivable.overdue && 'font-bold text-warn')}>
      {receivable.ageDays} 天
      {receivable.overdue ? (
        <span className="sr-only">（超过 30 天）</span>
      ) : null}
    </span>
  );
}

const overdueRow = 'bg-warn-soft shadow-[inset_3px_0_0_var(--warn-fg)]';

function ReceivableTable({
  items,
  onConfirm,
  isBlocked,
}: {
  items: AdminReceivable[];
  onConfirm: (receivable: AdminReceivable) => void;
  isBlocked: (receivable: AdminReceivable) => boolean;
}) {
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <table className="w-full border-collapse text-[13px] whitespace-nowrap">
        <thead>
          <tr className="bg-muted text-xs text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">租户</th>
            <th className="px-3 py-2.5 text-left font-medium">赊账时间</th>
            <th className="px-3 py-2.5 text-right font-medium">金额</th>
            <th className="py-2.5 pr-3 pl-7 text-left font-medium">操作人</th>
            <th className="px-3 py-2.5 text-left font-medium">备注</th>
            <th className="px-3 py-2.5 text-right font-medium">已欠天数</th>
            <th className="px-4 py-2.5">
              <span className="sr-only">操作</span>
            </th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {items.map((receivable) => (
            <tr
              key={receivable.ledgerEntryId}
              className={cn(
                'border-t border-border',
                receivable.overdue && overdueRow,
              )}
            >
              <td className="px-4 py-[11px]">
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm">{receivable.tenant.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {receivable.tenant.code} · {receivable.tenant.currency}
                  </span>
                </span>
              </td>
              <td className="px-3 py-[11px]">
                <DateTime value={receivable.createdAt} />
              </td>
              <td className="px-3 py-[11px] text-right text-sm font-semibold">
                <Money value={receivableMoney(receivable)} tone="plain" />
              </td>
              <td className="py-[11px] pr-3 pl-7 text-muted-foreground">
                {receivable.actor.name}
              </td>
              <td className="max-w-[280px] truncate px-3 py-[11px]">
                {receivable.internalNote}
              </td>
              <td className="px-3 py-[11px] text-right">
                <AgeDays receivable={receivable} />
              </td>
              <td className="px-4 py-2 text-right">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`确认收款 ${receivable.tenant.code} ${formatMoney(receivableMoney(receivable))}`}
                  disabled={isBlocked(receivable)}
                  onClick={() => onConfirm(receivable)}
                  className="h-[30px] bg-background text-primary"
                >
                  确认收款
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReceivableCards({
  items,
  onConfirm,
  isBlocked,
}: {
  items: AdminReceivable[];
  onConfirm: (receivable: AdminReceivable) => void;
  isBlocked: (receivable: AdminReceivable) => boolean;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0 tabular-nums md:hidden">
      {items.map((receivable) => (
        <li
          key={receivable.ledgerEntryId}
          className={cn(
            'flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3',
            receivable.overdue && overdueRow,
          )}
        >
          <span className="flex items-center justify-between gap-2">
            <span className="truncate text-[15px] font-medium">
              {receivable.tenant.name}
            </span>
            <Money
              value={receivableMoney(receivable)}
              tone="plain"
              className="text-[15px] font-semibold whitespace-nowrap"
            />
          </span>
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {receivable.tenant.code} · {receivable.actor.name}
            </span>
            <span className="whitespace-nowrap">
              已欠 <AgeDays receivable={receivable} />
            </span>
          </span>
          <Button
            variant="outline"
            aria-label={`确认收款 ${receivable.tenant.code} ${formatMoney(receivableMoney(receivable))}`}
            disabled={isBlocked(receivable)}
            onClick={() => onConfirm(receivable)}
            className="mt-1 h-10 bg-background text-primary"
          >
            确认收款
          </Button>
        </li>
      ))}
    </ul>
  );
}

function filterSummary(search: ReceivablesSearch) {
  return [
    search.search ? `搜索「${search.search}」` : null,
    search.currency ? `币种：${search.currency}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function EmptyState({ search }: { search: ReceivablesSearch }) {
  const { update } = useReceivablesSearch();
  const summary = filterSummary(search);
  if (!summary)
    return (
      <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-12 text-center">
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-lg font-bold text-ok md:size-12 md:text-xl"
        >
          ✓
        </span>
        <span className="text-[15px] font-semibold md:text-base">
          所有赊账均已收款
        </span>
        <span className="text-[13px] text-muted-foreground">
          新的赊账充值会出现在这里
        </span>
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
      <span className="text-[15px] font-semibold">没有符合条件的待收款</span>
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
      aria-label="待收款加载中"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="border-b border-border px-3.5 py-2.5 text-xs text-muted-foreground">
        加载中
      </div>
      {[1, 2, 3, 4].map((row) => (
        <div
          key={row}
          className="grid h-11 grid-cols-[2fr_1.4fr_1fr_1fr] items-center gap-3.5 border-b border-border px-3.5 last:border-b-0"
        >
          <span className="h-2.5 w-4/5 rounded bg-skeleton" />
          <span className="h-2.5 w-[70%] rounded bg-skeleton" />
          <span className="h-2.5 w-[65%] justify-self-end rounded bg-skeleton" />
          <span className="h-[18px] w-[60%] justify-self-end rounded-md bg-skeleton" />
        </div>
      ))}
    </div>
  );
}

function ConfirmedNotice({
  receivable,
  onDismiss,
  ref,
}: {
  receivable: AdminReceivable;
  onDismiss: () => void;
  ref: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      role="status"
      tabIndex={-1}
      className="flex items-center gap-2 rounded-[10px] border border-ok-border bg-ok-soft px-3.5 py-2.5 text-sm text-ok outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      <span aria-hidden className="font-bold">
        ✓
      </span>
      <span className="flex-1">
        {receivable.tenant.code} {formatMoney(receivableMoney(receivable))}{' '}
        已确认收款，状态变为「已收款」
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-label="关闭提示"
        onClick={onDismiss}
        className="h-7 px-2 text-ok hover:bg-transparent"
      >
        ✕
      </Button>
    </div>
  );
}

/**
 * 待收款（设计稿第二批 6a–6g，pages.md §3.8）：只列 pending，顺序沿用接口默认顺序。
 * 已收款、已作废视图与撤销、作废操作待定（G1/G2），这里不显示。
 */
export function ReceivablesPage({ identity }: { identity: Identity }) {
  const { search, update } = useReceivablesSearch();
  const page = search.page ?? 1;
  const [requests] = useState(sequencedRequests);
  const listInput = {
    query: {
      ...search,
      status: 'pending' as const,
      page,
      pageSize: receivablePageSize,
    },
  };
  const listKey = apiKey('adminReceivables', listInput);
  const receivables = useQuery({
    queryKey: listKey,
    queryFn: requests.wrap(() => send('adminReceivables', listInput)),
    placeholderData: keepPreviousData,
  });
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState<AdminReceivable | null>(null);
  const [confirmed, setConfirmed] = useState<AdminReceivable | null>(null);
  /** 确认失败后需要与服务端核对的行：ledgerEntryId → 发起核对时已发出的最大列表请求序号。 */
  const [reconciling, setReconciling] = useState<Record<string, number>>({});
  const noticeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const data = receivables.data;
  const lastPage = Math.max(
    1,
    Math.ceil((data?.pagination.total ?? 0) / receivablePageSize),
  );
  // 本页最后一笔被确认（或 URL 里的页码过大）后跳到最后一个有效页，而不是显示空页。
  const pastLastPage =
    data !== undefined &&
    !receivables.isPlaceholderData &&
    data.items.length === 0 &&
    page > lastPage;

  const goToPage = (next: number) =>
    update(
      next > 1 ? { ...withoutPage(search), page: next } : withoutPage(search),
    );

  useEffect(() => {
    if (pastLastPage) goToPage(lastPage);
  });

  const refreshOf = (receivable: AdminReceivable) =>
    requests.refresh(reconciling[receivable.ledgerEntryId], receivables);
  const pendingRefresh = data?.items.find(
    (item) => refreshOf(item) === 'refreshing',
  );

  function reconcile(receivable: AdminReceivable) {
    const mark = requests.mark();
    setReconciling((flagged) => ({
      ...flagged,
      [receivable.ledgerEntryId]: mark,
    }));
    void invalidateTenant(queryClient, receivable.tenant.id).then(() => {
      // 失效只会取消已有数据的查询的在途请求；若沿用了核对前发出的请求，补发一次。
      if (requests.mark() === mark)
        void queryClient.refetchQueries({ queryKey: listKey, exact: true });
    });
  }

  function openConfirm(receivable: AdminReceivable) {
    setConfirmed(null);
    setConfirming(receivable);
  }

  return (
    <AppShell
      identity={identity}
      title="待收款"
      crumb="待收款"
      activeNav="待收款"
    >
      <PageBody title="待收款" meta="赊账充值，客户付款后确认收款">
        {confirmed ? (
          <ConfirmedNotice
            ref={noticeRef}
            receivable={confirmed}
            onDismiss={() => setConfirmed(null)}
          />
        ) : null}
        {data ? (
          <Totals
            totals={receivables.isPlaceholderData ? null : data.totals}
            currency={search.currency}
          />
        ) : null}
        <Filters />
        <section
          ref={listRef}
          tabIndex={-1}
          aria-label="待收款列表"
          className="flex flex-col gap-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          {pendingRefresh ? (
            <p className="m-0 text-[13px] text-muted-foreground">
              正在刷新列表，刷新完成前不能确认 {pendingRefresh.tenant.code}{' '}
              {formatMoney(receivableMoney(pendingRefresh))}。
            </p>
          ) : null}
          {receivables.isError && data ? (
            <QueryError
              title="待收款刷新失败，列表可能不是最新"
              error={receivables.error}
              retrying={receivables.isFetching}
              onRetry={() => void receivables.refetch()}
            />
          ) : null}
          {receivables.isError && !data ? (
            <QueryError
              title="待收款加载失败"
              error={receivables.error}
              retrying={receivables.isFetching}
              onRetry={() => void receivables.refetch()}
            />
          ) : !data || pastLastPage ? (
            <LoadingRows />
          ) : data.pagination.total === 0 ? (
            <EmptyState search={search} />
          ) : (
            <>
              <ReceivableTable
                items={data.items}
                onConfirm={openConfirm}
                isBlocked={(receivable) => refreshOf(receivable) !== 'fresh'}
              />
              <ReceivableCards
                items={data.items}
                onConfirm={openConfirm}
                isBlocked={(receivable) => refreshOf(receivable) !== 'fresh'}
              />
              <Pagination
                page={page}
                pageSize={receivablePageSize}
                rowCount={data.pagination.total}
                onPage={goToPage}
              />
            </>
          )}
        </section>
      </PageBody>
      {confirming ? (
        <ConfirmPaymentDialog
          key={confirming.ledgerEntryId}
          receivable={confirming}
          current={data?.items.find(
            (item) => item.ledgerEntryId === confirming.ledgerEntryId,
          )}
          refresh={refreshOf(confirming)}
          onReconcile={() => reconcile(confirming)}
          onRetryRefresh={() => void receivables.refetch()}
          returnFocus={noticeRef}
          fallbackFocus={listRef}
          onClose={() => setConfirming(null)}
          onDone={() => {
            setConfirmed(confirming);
            setConfirming(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}
