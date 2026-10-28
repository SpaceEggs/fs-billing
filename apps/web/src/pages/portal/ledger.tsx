import { useId } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import {
  formatMergedChargeNote,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  portalLedgerKindSchema,
  PORTAL_LEDGER_PAGE_SIZE,
  type Currency,
  type Identity,
  type PortalLedgerRow,
} from '@fs-billing/shared';
import { DownloadIcon } from 'lucide-react';
import { Skeleton } from '../../components/ui/skeleton';
import { Label } from '../../components/ui/label';
import { MobileBarButton } from '../../components/mobile-bar-button';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateTime, Money } from '../../components/data-format';
import { DateRangeField } from '../../components/date-range-field';
import {
  ChoiceGrid,
  FilterGroup,
  FilterSheet,
  resultLabel,
} from '../../components/filter-sheet';
import { Pagination } from '../../components/pagination';
import { QueryError, RefreshError } from '../../components/query-error';
import { Button } from '../../components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '../../components/ui/native-select';
import { apiQuery } from '../../lib/admin-api';
import { ApiRequestError, callDownload } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import { beijingMonthToDate, rangeOrMonthToDate } from '../../lib/day-range';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  cdrDayHref,
  portalLedgerKindLabels,
  type PortalLedgerFilter,
  type PortalLedgerSearch,
} from '../../lib/portal-ledger';

const kindChoices = [
  { value: undefined, label: '全部类型' },
  ...portalLedgerKindSchema.options.map((value) => ({
    value,
    label: portalLedgerKindLabels[value],
  })),
];

const rowKey = (row: PortalLedgerRow) =>
  row.kind === 'call_charge' ? `${row.kind}:${row.day}` : row.id;

/** 人工流水按输入精度显示（调账可到 4 位小数）；合并的通话扣费按 2 位舍入。 */
const exactAmount = (row: PortalLedgerRow) => row.kind !== 'call_charge';

/** 合并行的备注，点击进入当天话单。 */
function CdrDayLink({
  day,
  partial,
  children,
}: {
  day: string;
  partial: boolean;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const href = cdrDayHref(day);
  return (
    <a
      href={href}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        router.history.push(href);
      }}
      className="inline-flex items-center gap-1.5 underline-offset-4 hover:underline"
    >
      {partial ? (
        <span aria-hidden className="size-1.5 rounded-full bg-pos" />
      ) : null}
      {children} →
    </a>
  );
}

function Note({ row }: { row: PortalLedgerRow }) {
  if (row.kind === 'call_charge')
    return (
      <CdrDayLink day={row.day} partial={row.partial}>
        {formatMergedChargeNote(row)}
      </CdrDayLink>
    );
  return <span>{row.note || '—'}</span>;
}

function LedgerTable({
  currency,
  items,
}: {
  currency: Currency;
  items: PortalLedgerRow[];
}) {
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-muted text-xs whitespace-nowrap text-muted-foreground">
            <th className="w-[180px] px-4 py-2.5 text-left font-medium">
              时间
            </th>
            <th className="w-[110px] px-3 py-2.5 text-left font-medium">
              类型
            </th>
            <th className="w-[140px] px-3 py-2.5 text-right font-medium">
              金额
            </th>
            <th className="w-[150px] px-3 py-2.5 text-right font-medium">
              变动后余额
            </th>
            <th className="py-2.5 pr-4 pl-8 text-left font-medium">备注</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {items.map((row) => (
            <tr
              key={rowKey(row)}
              className="border-t border-border hover:bg-muted/40"
            >
              <td className="px-4 py-2.5 whitespace-nowrap">
                <DateTime value={row.occurredAt} />
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                {portalLedgerKindLabels[row.kind]}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">
                <Money
                  value={{ currency, amount: row.amount }}
                  tone="signed"
                  exact={exactAmount(row)}
                />
              </td>
              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                <Money value={{ currency, amount: row.balanceAfter }} />
              </td>
              <td className="py-2.5 pr-4 pl-8">
                <Note row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LedgerCards({
  currency,
  items,
}: {
  currency: Currency;
  items: PortalLedgerRow[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((row) => (
        <li
          key={rowKey(row)}
          className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3 tabular-nums"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[15px] font-medium">
              {portalLedgerKindLabels[row.kind]}
            </span>
            <Money
              value={{ currency, amount: row.amount }}
              tone="signed"
              exact={exactAmount(row)}
              className="text-[15px] font-semibold"
            />
          </div>
          <div className="text-[13px]">
            <Note row={row} />
          </div>
          <div className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span>{formatDateTime(row.occurredAt).slice(5, 16)}</span>
            <span className="whitespace-nowrap">
              余额 <Money value={{ currency, amount: row.balanceAfter }} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function exportFailure(error: unknown) {
  if (error instanceof ApiRequestError && error.status === 0)
    return '导出中断，请重试';
  const notice = problemNotice(apiProblem(error));
  return notice.body ? `${notice.title}，${notice.body}` : notice.title;
}

/**
 * 余额流水（设计稿第二批 5a 至 5f）：北京日范围（最长一个月，默认本月）与类型筛选，
 * 通话扣费按天合并，点击进入当天话单。导出的是当前筛选条件。
 */
export function PortalLedgerPage({
  identity,
  search,
  onSearch,
}: {
  identity: Identity;
  search: PortalLedgerSearch;
  onSearch: (patch: PortalLedgerSearch) => void;
}) {
  const kindId = useId();
  const { kind, page = 1 } = search;
  const now = new Date();
  const range = rangeOrMonthToDate(search, now);
  const rangeIsOverlong = !isDayRangeWithinOneMonth(range.from, range.to);
  const filter: PortalLedgerFilter = { ...range, ...(kind ? { kind } : {}) };
  /** 改筛选回到第一页。 */
  const setFilter = (patch: Omit<PortalLedgerSearch, 'page'>) =>
    onSearch({ ...patch, page: undefined });
  const ledger = useQuery({
    ...apiQuery('portalLedger', { query: { ...filter, page } }),
    enabled: !rangeIsOverlong,
    placeholderData: keepPreviousData,
  });
  const data = rangeIsOverlong ? undefined : ledger.data;
  const download = useMutation({
    mutationFn: (current: PortalLedgerFilter) =>
      callDownload('portalLedgerExport', { body: current }),
  });
  const canExport = !rangeIsOverlong && !download.isPending;
  const exportLabel = download.isPending ? '导出中…' : '导出 CSV';
  const crumb =
    identity.kind === 'customer'
      ? `${identity.tenant.code} · ${identity.tenant.name}`
      : '';
  const isDefaultView =
    !kind &&
    range.from === beijingMonthToDate(now).from &&
    range.to === beijingMonthToDate(now).to;

  return (
    <AppShell
      identity={identity}
      title="余额流水"
      crumb={crumb}
      activeNav="余额流水"
      mobileActions={
        <MobileBarButton
          aria-label="导出 CSV"
          disabled={!canExport}
          onClick={() => download.mutate(filter)}
          className="border-0"
        >
          <DownloadIcon aria-hidden />
        </MobileBarButton>
      }
    >
      <PageBody
        title="余额流水"
        meta={
          data ? (
            <>
              当前余额{' '}
              <Money
                value={{ currency: data.currency, amount: data.balance }}
                className="font-semibold"
              />
            </>
          ) : undefined
        }
        actions={
          <Button
            variant="outline"
            disabled={!canExport}
            onClick={() => download.mutate(filter)}
          >
            {exportLabel}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <DateRangeField
            label="日期范围（北京时间）"
            value={range}
            max={formatDate(now)}
            maxRangeEndForStart={latestRangeEnd}
            onChange={(next) => setFilter(next)}
            className="min-w-0 flex-1 md:w-[260px] md:flex-none"
          />
          <FilterSheet
            activeCount={kind ? 1 : 0}
            resultLabel={resultLabel(data?.pagination.total, '条')}
            onClear={() => setFilter({ kind: undefined })}
          >
            <FilterGroup label="类型">
              {(labelId) => (
                <ChoiceGrid
                  labelledBy={labelId}
                  options={kindChoices}
                  value={kind}
                  onChange={(next) => setFilter({ kind: next })}
                />
              )}
            </FilterGroup>
          </FilterSheet>
          <div className="hidden md:contents">
            <Label htmlFor={kindId} className="sr-only">
              类型
            </Label>
            <NativeSelect
              id={kindId}
              value={kind ?? ''}
              onChange={(event) =>
                setFilter({
                  kind: portalLedgerKindSchema.safeParse(event.target.value)
                    .data,
                })
              }
              containerClassName="w-40"
            >
              {kindChoices.map((option) => (
                <NativeSelectOption
                  key={option.value ?? ''}
                  value={option.value ?? ''}
                >
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground">
              通话扣费按天合并，点击可查看当天话单
            </span>
          </div>
        </div>
        {download.isError ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-err/30 bg-err/5 px-3.5 py-2.5 text-[13px] text-err"
          >
            <span className="flex-1">
              导出失败：{exportFailure(download.error)}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!canExport}
              onClick={() => download.mutate(filter)}
            >
              重试
            </Button>
          </div>
        ) : null}
        <RefreshError
          title="余额流水刷新失败，列表可能不是最新"
          query={ledger}
        />
        {rangeIsOverlong ? (
          <div
            role="alert"
            className="rounded-lg border border-err/30 bg-err/5 px-3.5 py-3 text-[13px] text-err"
          >
            日期范围超出一个月上限：{range.from} 至 {range.to}。结束日期不能晚于{' '}
            {latestRangeEnd(range.from)}。
          </div>
        ) : null}
        {data ? (
          <div className="flex justify-between gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground md:justify-start md:text-[13px]">
            <span>
              共 {data.pagination.total} 条
              {kind ? (
                <>
                  {' · 合计 '}
                  <Money
                    value={{
                      currency: data.currency,
                      amount: data.totalAmount,
                    }}
                    tone="signed"
                    exact
                  />
                </>
              ) : null}
            </span>
            <span className="md:hidden">
              当前余额{' '}
              <Money
                value={{ currency: data.currency, amount: data.balance }}
                className="font-semibold"
              />
            </span>
          </div>
        ) : null}
        {rangeIsOverlong ? null : ledger.isError && !data ? (
          <QueryError
            title="余额流水加载失败"
            error={ledger.error}
            retrying={ledger.isFetching}
            onRetry={() => void ledger.refetch()}
          />
        ) : !data ? (
          <Skeleton
            aria-busy
            aria-label="余额流水加载中"
            className="h-[240px] rounded-xl"
          />
        ) : data.items.length === 0 ? (
          isDefaultView ? (
            <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
              <span className="text-[15px] font-semibold">还没有余额流水</span>
              <span className="text-[13px] text-muted-foreground">
                充值到账或产生通话扣费后，每一笔变动都会记录在这里
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
              <span className="text-[15px] font-semibold">
                没有符合条件的流水
              </span>
              <span className="text-[13px] text-muted-foreground">
                {range.from} — {range.to.slice(5)}
                {kind ? ` · 类型：${portalLedgerKindLabels[kind]}` : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  onSearch({
                    from: undefined,
                    to: undefined,
                    kind: undefined,
                    page: undefined,
                  })
                }
              >
                清除筛选
              </Button>
            </div>
          )
        ) : (
          <>
            <LedgerTable currency={data.currency} items={data.items} />
            <LedgerCards currency={data.currency} items={data.items} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground tabular-nums">
              <span>
                第 {(page - 1) * PORTAL_LEDGER_PAGE_SIZE + 1}–
                {(page - 1) * PORTAL_LEDGER_PAGE_SIZE + data.items.length}{' '}
                条，共 {data.pagination.total} 条
              </span>
              <Pagination
                page={page}
                pageSize={PORTAL_LEDGER_PAGE_SIZE}
                rowCount={data.pagination.total}
                onPage={(next) =>
                  onSearch({ page: next > 1 ? next : undefined })
                }
              />
            </div>
          </>
        )}
      </PageBody>
    </AppShell>
  );
}
