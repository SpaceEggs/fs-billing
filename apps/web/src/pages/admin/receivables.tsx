import { useEffect, useRef, useState } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  adminReceivableStatusSchema,
  currencySchema,
  type AdminReceivable,
  type AdminReceivableStatus,
  type Identity,
} from '@fs-billing/shared';
import { BalanceDialog } from '../../components/admin/balance-dialog';
import {
  ConfirmPaymentDialog,
  receivableMoney,
} from '../../components/admin/confirm-payment-dialog';
import { ReversePaymentDialog } from '../../components/admin/reverse-payment-dialog';
import { VoidReceivableDialog } from '../../components/admin/void-receivable-dialog';
import { ModalDialog } from '../../components/ui/dialog';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateTime, Money } from '../../components/data-format';
import { Pagination } from '../../components/pagination';
import { QueryError } from '../../components/query-error';
import { SearchBox } from '../../components/search-box';
import { Button } from '../../components/ui/button';
import { apiKey, apiQuery, invalidateTenant, send } from '../../lib/admin-api';
import type { ReceivablesSearch } from '../../lib/admin-search';
import { formatDate, formatMoney } from '../../lib/format';
import {
  adminName,
  adminNames,
  receivableViews,
  sequencedRequests,
  type Sequenced,
  visibleTotals,
} from '../../lib/receivables';
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

type Received = Extract<AdminReceivable['payment'], { status: 'received' }>;
type Names = { data: Map<string, string> | undefined; isPending: boolean };

const statusOf = (search: ReceivablesSearch): AdminReceivableStatus =>
  search.status ?? 'pending';

function Segmented<Value extends string | undefined>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="flex h-11 gap-0.5 self-start rounded-lg bg-muted p-[3px] text-[13px] md:h-9"
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value ?? 'all'}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'rounded-md px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              selected
                ? 'bg-background font-medium shadow-[0_1px_2px_rgba(0,0,0,.1)]'
                : 'text-muted-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

const statusOptions = adminReceivableStatusSchema.options.map((status) => ({
  value: status,
  label: receivableViews[status].label,
}));
const currencyOptions = [
  { value: undefined, label: '全部币种' },
  ...currencySchema.options.map((currency) => ({
    value: currency,
    label: currency,
  })),
];

/** 状态分段（G1）驱动接口的 status 参数；默认待收款不写入地址，切换回到第一页。 */
function Filters() {
  const { search, setFilter } = useReceivablesSearch();
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-3">
      <Segmented
        label="状态"
        options={statusOptions}
        value={statusOf(search)}
        onChange={(status) =>
          setFilter({ status: status === 'pending' ? undefined : status })
        }
      />
      <SearchBox
        label="搜索租户"
        value={search.search ?? ''}
        onChange={(value) =>
          setFilter({ search: value === '' ? undefined : value })
        }
        className="md:w-[260px]"
      />
      <Segmented
        label="币种"
        options={currencyOptions}
        value={search.currency}
        onChange={(currency) => setFilter({ currency })}
      />
    </div>
  );
}

const zeroTotals = { CNY: '0', USD: '0' };

/**
 * 分币种合计（6a/6b）：按所选状态与筛选后的全部结果统计，不只当前页；CNY 与 USD 不相加。
 * 接口按 status 求和，所以已收款、已作废视图显示的是该状态的赊账金额合计。
 * `totals` 为 null 表示新状态或筛选的结果还没到：上一次响应的合计不能当作当前合计显示。
 */
function Totals({
  status,
  totals,
  currency,
}: {
  status: AdminReceivableStatus;
  totals: Parameters<typeof visibleTotals>[0] | null;
  currency: ReceivablesSearch['currency'];
}) {
  const { label } = receivableViews[status];
  return (
    <ul
      aria-label={`${label}合计`}
      aria-busy={totals === null}
      className="m-0 grid list-none grid-cols-2 gap-2.5 p-0 tabular-nums md:grid-cols-3 md:gap-4"
    >
      {visibleTotals(totals ?? zeroTotals, currency).map((money) => (
        <li
          key={money.currency}
          aria-label={`${label}总额 ${money.currency}`}
          className="flex flex-col gap-1 rounded-xl border border-border px-3.5 py-3 md:gap-1.5 md:px-5 md:py-[18px]"
        >
          <span className="text-xs text-muted-foreground md:text-[13px]">
            <span className="hidden md:inline">{label}总额 · </span>
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

/** 逾期只看接口的 overdue（决定 10：北京时间自然日差超过 30 天），只有待收款会逾期。 */
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

const personName = (names: Names, id: string) =>
  names.isPending ? '…' : adminName(names.data, id);

/** 各状态特有的列：表头按所选视图，单元格按该行的 payment（接口按 status 过滤，两者一致）。 */
const statusHeaders = {
  pending: [{ label: '已欠天数', right: true }],
  received: [
    { label: '收款日期', right: false },
    { label: '确认人', right: false },
    { label: '收款备注', right: false },
  ],
  voided: [
    { label: '作废时间', right: false },
    { label: '作废人', right: false },
    { label: '作废原因', right: false },
  ],
} satisfies Record<AdminReceivableStatus, { label: string; right: boolean }[]>;

function statusCells(receivable: AdminReceivable, names: Names) {
  const { payment } = receivable;
  switch (payment.status) {
    case 'pending':
      return [<AgeDays key="age" receivable={receivable} />];
    case 'received':
      return [
        payment.receivedOn,
        personName(names, payment.confirmedBy),
        payment.note || '—',
      ];
    case 'voided':
      return [
        <DateTime key="at" value={payment.voidedAt} />,
        personName(names, payment.voidedBy),
        payment.reason,
      ];
  }
}

type RowActions = {
  onConfirm: (receivable: AdminReceivable) => void;
  onVoid: (receivable: AdminReceivable) => void;
  onReverse: (receivable: AdminReceivable, payment: Received) => void;
  isBlocked: (receivable: AdminReceivable) => boolean;
};

/** 行内操作（G1）：待收款可确认收款或作废，已收款可撤销确认，已作废只读。 */
function Actions({
  receivable,
  actions,
  mobile,
}: {
  receivable: AdminReceivable;
  actions: RowActions;
  mobile: boolean;
}) {
  const { payment } = receivable;
  const target = `${receivable.tenant.code} ${formatMoney(receivableMoney(receivable))}`;
  const blocked = actions.isBlocked(receivable);
  const size = mobile ? 'h-10 flex-1' : 'h-[30px]';
  if (payment.status === 'voided') return null;
  // 手机按钮用 flex-1 横向铺满，必须放在横向的 flex 容器里，否则在卡片的纵向 flex 中被压扁。
  const row = cn('flex gap-2', mobile ? 'mt-1' : 'justify-end');
  if (payment.status === 'received')
    return (
      <span className={row}>
        <Button
          variant="danger"
          size="sm"
          aria-label={`撤销确认 ${target}`}
          disabled={blocked}
          onClick={() => actions.onReverse(receivable, payment)}
          className={cn('bg-background', size)}
        >
          撤销确认
        </Button>
      </span>
    );
  return (
    <span className={row}>
      <Button
        variant="outline"
        size="sm"
        aria-label={`确认收款 ${target}`}
        disabled={blocked}
        onClick={() => actions.onConfirm(receivable)}
        className={cn('bg-background text-primary', size)}
      >
        确认收款
      </Button>
      <Button
        variant="danger"
        size="sm"
        aria-label={`作废 ${target}`}
        disabled={blocked}
        onClick={() => actions.onVoid(receivable)}
        className={cn('bg-background', size)}
      >
        作废
      </Button>
    </span>
  );
}

function ReceivableTable({
  status,
  items,
  names,
  actions,
}: {
  status: AdminReceivableStatus;
  items: AdminReceivable[];
  names: Names;
  actions: RowActions;
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
            {statusHeaders[status].map((header) => (
              <th
                key={header.label}
                className={cn(
                  'px-3 py-2.5 font-medium',
                  header.right ? 'text-right' : 'text-left',
                )}
              >
                {header.label}
              </th>
            ))}
            {status === 'voided' ? null : (
              <th className="px-4 py-2.5">
                <span className="sr-only">操作</span>
              </th>
            )}
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
              {statusCells(receivable, names).map((cell, index) => (
                <td
                  key={statusHeaders[status][index]?.label ?? index}
                  className={cn(
                    'max-w-[240px] truncate px-3 py-[11px]',
                    statusHeaders[status][index]?.right && 'text-right',
                  )}
                >
                  {cell}
                </td>
              ))}
              {status === 'voided' ? null : (
                <td className="px-4 py-2 text-right">
                  <Actions
                    receivable={receivable}
                    actions={actions}
                    mobile={false}
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReceivableCards({
  status,
  items,
  names,
  actions,
}: {
  status: AdminReceivableStatus;
  items: AdminReceivable[];
  names: Names;
  actions: RowActions;
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
            {receivable.payment.status === 'pending' ? (
              <span className="whitespace-nowrap">
                已欠 <AgeDays receivable={receivable} />
              </span>
            ) : null}
          </span>
          {receivable.payment.status === 'pending' ? null : (
            <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
              {statusCells(receivable, names).map((cell, index) => (
                <span key={index} className="contents">
                  <dt className="text-muted-foreground">
                    {statusHeaders[status][index]?.label}
                  </dt>
                  <dd className="m-0 break-all">{cell}</dd>
                </span>
              ))}
            </dl>
          )}
          <Actions receivable={receivable} actions={actions} mobile />
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
  const status = statusOf(search);
  const view = receivableViews[status];
  const summary = filterSummary(search);
  if (!summary)
    return (
      <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-12 text-center">
        {status === 'pending' ? (
          <span
            aria-hidden
            className="flex size-11 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-lg font-bold text-ok md:size-12 md:text-xl"
          >
            ✓
          </span>
        ) : null}
        <span className="text-[15px] font-semibold md:text-base">
          {view.empty.title}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {view.empty.hint}
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
      <span className="text-[15px] font-semibold">
        没有符合条件的{view.label}
      </span>
      <span className="text-[13px] text-muted-foreground">{summary}</span>
      <Button
        variant="outline"
        size="sm"
        onClick={() => update(search.status ? { status: search.status } : {})}
      >
        清除筛选
      </Button>
    </div>
  );
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div
      aria-busy
      aria-label={`${label}加载中`}
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

type Done = {
  kind: 'confirm' | 'reverse' | 'void';
  receivable: AdminReceivable;
};

const doneText = {
  confirm: '已确认收款，状态变为「已收款」',
  reverse: '已撤销确认，回到「待收款」',
  void: '已作废，状态变为「已作废」',
} satisfies Record<Done['kind'], string>;

function DoneNotice({
  done,
  onDismiss,
  ref,
}: {
  done: Done;
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
        {done.receivable.tenant.code}{' '}
        {formatMoney(receivableMoney(done.receivable))} {doneText[done.kind]}
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
 * 作废前的冲正调账：打开该租户的余额操作对话框，预填调账金额为赊账金额的相反数。
 * 调账的说明客户可见，所以预填文字只写日期与金额，不带内部备注或流水 ID。
 */
function ReversalAdjustment({
  owner,
  receivable,
  onClose,
}: {
  owner: string;
  receivable: AdminReceivable;
  onClose: () => void;
}) {
  const tenantId = receivable.tenant.id;
  const detail = useQuery(
    apiQuery('adminTenantDetail', { params: { tenantId } }),
  );
  const navigate = useNavigate();
  if (detail.data)
    return (
      <BalanceDialog
        owner={owner}
        tenant={detail.data}
        open
        onOpenChange={(open) => open || onClose()}
        initialDraft={{
          kind: 'adjustment',
          amount: `-${receivable.amount}`,
          note: `冲正 ${formatDate(receivable.createdAt)} 充值 ${formatMoney(receivableMoney(receivable))}`,
        }}
        onViewLedger={() =>
          void navigate({
            to: '/admin/tenants/$tenantId',
            params: { tenantId },
            search: { tab: 'ledger' },
          })
        }
      />
    );
  return (
    <ModalDialog
      open
      onOpenChange={(open) => open || onClose()}
      title="余额操作"
    >
      {detail.isError ? (
        <QueryError
          title="租户信息加载失败，无法打开调账"
          error={detail.error}
          retrying={detail.isFetching}
          onRetry={() => void detail.refetch()}
        />
      ) : (
        <p aria-busy className="m-0 text-sm text-muted-foreground">
          正在加载租户信息…
        </p>
      )}
      <Button variant="outline" className="self-end" onClick={onClose}>
        返回
      </Button>
    </ModalDialog>
  );
}

type Dialog =
  | { kind: 'confirm' | 'void' | 'adjust'; receivable: AdminReceivable }
  | { kind: 'reverse'; receivable: AdminReceivable; payment: Received };

/**
 * 待收款（设计稿第二批 6a–6g，pages.md §3.8）加已收款、已作废视图（G1）：顺序沿用接口默认顺序。
 * 待收款可确认收款、作废，已收款可撤销确认，已作废只读。
 */
export function ReceivablesPage({ identity }: { identity: Identity }) {
  const { search, update } = useReceivablesSearch();
  const status = statusOf(search);
  const view = receivableViews[status];
  const page = search.page ?? 1;
  const [requests] = useState(sequencedRequests);
  const listInput = {
    query: { ...search, status, page, pageSize: receivablePageSize },
  };
  const listKey = apiKey('adminReceivables', listInput);
  const receivables = useQuery({
    queryKey: listKey,
    queryFn: requests.wrap(async () => ({
      ...(await send('adminReceivables', listInput)),
      status,
    })),
    // 换状态时不沿用上一状态的行：列和操作都不同。
    placeholderData: keepPreviousData,
  });
  const names = useQuery({ ...adminNames, enabled: status !== 'pending' });
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  /** 操作失败后需要与服务端核对的行：ledgerEntryId → 发起核对时已发出的最大列表请求序号。 */
  const [reconciling, setReconciling] = useState<Record<string, number>>({});
  const noticeRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLElement>(null);
  // 换状态时不沿用上一状态的行：列和操作都不同。
  const data =
    receivables.data?.status === status ? receivables.data : undefined;
  const lastPage = Math.max(
    1,
    Math.ceil((data?.pagination.total ?? 0) / receivablePageSize),
  );
  // 本页最后一笔被处理（或 URL 里的页码过大）后跳到最后一个有效页，而不是显示空页。
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
      // 失效只会取消已有数据的查询的在途请求；若该列表沿用了核对前（或上次挂载）发出的请求，补发一次。
      const settled = queryClient.getQueryData<Sequenced<object>>(listKey);
      if (!requests.answers(mark, settled))
        void queryClient.refetchQueries({ queryKey: listKey, exact: true });
    });
  }

  const open = (next: Dialog) => {
    setDone(null);
    setDialog(next);
  };
  const actions: RowActions = {
    onConfirm: (receivable) => open({ kind: 'confirm', receivable }),
    onVoid: (receivable) => open({ kind: 'void', receivable }),
    onReverse: (receivable, payment) =>
      open({ kind: 'reverse', receivable, payment }),
    isBlocked: (receivable) => refreshOf(receivable) !== 'fresh',
  };

  const dialogProps = dialog && {
    current: data?.items.find(
      (item) => item.ledgerEntryId === dialog.receivable.ledgerEntryId,
    ),
    refresh: refreshOf(dialog.receivable),
    onReconcile: () => reconcile(dialog.receivable),
    onRetryRefresh: () => void receivables.refetch(),
    returnFocus: noticeRef,
    fallbackFocus: listRef,
    onClose: () => setDialog(null),
  };
  const finish = (kind: Done['kind'], receivable: AdminReceivable) => () => {
    setDone({ kind, receivable });
    setDialog(null);
  };

  return (
    <AppShell
      identity={identity}
      title="待收款"
      crumb="待收款"
      activeNav="待收款"
    >
      <PageBody title="待收款" meta="赊账充值，客户付款后确认收款">
        {done ? (
          <DoneNotice
            ref={noticeRef}
            done={done}
            onDismiss={() => setDone(null)}
          />
        ) : null}
        {data ? (
          <Totals
            status={status}
            totals={receivables.isPlaceholderData ? null : data.totals}
            currency={search.currency}
          />
        ) : null}
        <Filters />
        <section
          ref={listRef}
          tabIndex={-1}
          aria-label={`${view.label}列表`}
          className="flex flex-col gap-5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          {pendingRefresh ? (
            <p className="m-0 text-[13px] text-muted-foreground">
              正在刷新列表，刷新完成前不能操作 {pendingRefresh.tenant.code}{' '}
              {formatMoney(receivableMoney(pendingRefresh))}。
            </p>
          ) : null}
          {receivables.isError && data ? (
            <QueryError
              title={`${view.label}刷新失败，列表可能不是最新`}
              error={receivables.error}
              retrying={receivables.isFetching}
              onRetry={() => void receivables.refetch()}
            />
          ) : null}
          {receivables.isError && !data ? (
            <QueryError
              title={`${view.label}加载失败`}
              error={receivables.error}
              retrying={receivables.isFetching}
              onRetry={() => void receivables.refetch()}
            />
          ) : !data || pastLastPage ? (
            <LoadingRows label={view.label} />
          ) : data.pagination.total === 0 ? (
            <EmptyState search={search} />
          ) : (
            <>
              <ReceivableTable
                status={status}
                items={data.items}
                names={names}
                actions={actions}
              />
              <ReceivableCards
                status={status}
                items={data.items}
                names={names}
                actions={actions}
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
      {dialog?.kind === 'confirm' && dialogProps ? (
        <ConfirmPaymentDialog
          key={dialog.receivable.ledgerEntryId}
          receivable={dialog.receivable}
          {...dialogProps}
          onDone={finish('confirm', dialog.receivable)}
        />
      ) : null}
      {dialog?.kind === 'reverse' && dialogProps ? (
        <ReversePaymentDialog
          key={dialog.receivable.ledgerEntryId}
          receivable={dialog.receivable}
          payment={dialog.payment}
          confirmerName={personName(names, dialog.payment.confirmedBy)}
          {...dialogProps}
          onDone={finish('reverse', dialog.receivable)}
        />
      ) : null}
      {dialog?.kind === 'void' && dialogProps ? (
        <VoidReceivableDialog
          key={dialog.receivable.ledgerEntryId}
          receivable={dialog.receivable}
          {...dialogProps}
          onDone={finish('void', dialog.receivable)}
          onAdjust={() =>
            setDialog({ kind: 'adjust', receivable: dialog.receivable })
          }
        />
      ) : null}
      {dialog?.kind === 'adjust' ? (
        <ReversalAdjustment
          owner={identity.profileId}
          receivable={dialog.receivable}
          onClose={() =>
            setDialog({ kind: 'void', receivable: dialog.receivable })
          }
        />
      ) : null}
    </AppShell>
  );
}
