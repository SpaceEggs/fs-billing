import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useId } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  beijingDateOf,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  portalLedgerKindSchema,
  PORTAL_LEDGER_PAGE_SIZE,
  translate,
  type Currency,
  type Identity,
  type Locale,
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
import {
  formatDay,
  formatLedgerChargeNote,
  formatShortDateTime,
} from '../../lib/format';
import { useLocale } from '../../i18n';
import {
  cdrDayHref,
  portalLedgerKindLabel,
  type PortalLedgerFilter,
  type PortalLedgerSearch,
} from '../../lib/portal-ledger';

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

export function Note({ row }: { row: PortalLedgerRow }) {
  const locale = useLocale();
  if (row.kind === 'call_charge')
    return (
      <CdrDayLink day={row.day} partial={row.partial}>
        {formatLedgerChargeNote(row, locale)}
      </CdrDayLink>
    );
  if (row.noteKey)
    return <span>{translate(locale, `enums:${row.noteKey}`)}</span>;
  return <span>{row.note || '—'}</span>;
}

function LedgerTable({
  currency,
  items,
}: {
  currency: Currency;
  items: PortalLedgerRow[];
}) {
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <Table>
        <TableHeader>
          <TableRow className="border-t-0 whitespace-nowrap">
            <TableHead className="w-[180px] px-4">
              {t('portal:ledger.time')}
            </TableHead>
            <TableHead className="w-[110px]">
              {t('portal:ledger.kind')}
            </TableHead>
            <TableHead className="w-[140px] text-right">
              {t('portal:ledger.amount')}
            </TableHead>
            <TableHead className="w-[150px] text-right">
              {t('portal:ledger.balanceAfter')}
            </TableHead>
            <TableHead className="pr-4 pl-8">
              {t('portal:ledger.note')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {items.map((row) => (
            <TableRow key={rowKey(row)} className="hover:bg-muted/40">
              <TableCell className="px-4 py-2.5 whitespace-nowrap">
                <DateTime value={row.occurredAt} />
              </TableCell>
              <TableCell className="py-2.5 whitespace-nowrap">
                {portalLedgerKindLabel(row.kind, locale)}
              </TableCell>
              <TableCell className="py-2.5 text-right font-semibold whitespace-nowrap">
                <Money
                  value={{ currency, amount: row.amount }}
                  tone="signed"
                  exact={exactAmount(row)}
                />
              </TableCell>
              <TableCell className="py-2.5 text-right whitespace-nowrap">
                <Money value={{ currency, amount: row.balanceAfter }} />
              </TableCell>
              <TableCell className="py-2.5 pr-4 pl-8">
                <Note row={row} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
  const { t } = useTranslation(['portal']);
  const locale = useLocale();
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((row) => (
        <li
          key={rowKey(row)}
          className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3 tabular-nums"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-[15px] font-medium">
              {portalLedgerKindLabel(row.kind, locale)}
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
            <span>{formatShortDateTime(row.occurredAt, locale, false)}</span>
            <span className="whitespace-nowrap">
              {t('portal:ledger.balance')}{' '}
              <Money value={{ currency, amount: row.balanceAfter }} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

function exportFailure(error: unknown, locale: Locale) {
  if (error instanceof ApiRequestError && error.status === 0)
    return translate(locale, 'portal:ledger.exportInterrupted');
  const notice = problemNotice(apiProblem(error));
  return notice.body
    ? translate(locale, 'common:error.titleBody', {
        title: notice.title,
        body: notice.body,
      })
    : notice.title;
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
  const { t } = useTranslation(['portal', 'common']);
  const kindId = useId();
  const locale = useLocale();
  const kindChoices = [
    { value: undefined, label: t('portal:ledger.allKinds') },
    ...portalLedgerKindSchema.options.map((value) => ({
      value,
      label: portalLedgerKindLabel(value, locale),
    })),
  ];
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
  const exportLabel = download.isPending
    ? t('portal:ledger.exporting')
    : t('portal:ledger.export');
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
      title={t('portal:ledger.title')}
      crumb={crumb}
      activeNav={translate('zh', 'shell:nav.ledger')}
      mobileActions={
        <MobileBarButton
          aria-label={t('portal:ledger.export')}
          disabled={!canExport}
          onClick={() => download.mutate(filter)}
          className="border-0"
        >
          <DownloadIcon aria-hidden />
        </MobileBarButton>
      }
    >
      <PageBody
        title={t('portal:ledger.title')}
        meta={
          data ? (
            <>
              {t('portal:ledger.currentBalance')}{' '}
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
            label={t('portal:ledger.dateRange')}
            value={range}
            max={beijingDateOf(now)}
            maxRangeEndForStart={latestRangeEnd}
            onChange={(next) => setFilter(next)}
            className="min-w-0 flex-1 md:w-[260px] md:flex-none"
          />
          <FilterSheet
            activeCount={kind ? 1 : 0}
            resultLabel={resultLabel(
              data?.pagination.total,
              t('portal:ledger.unit'),
              locale,
            )}
            onClear={() => setFilter({ kind: undefined })}
          >
            <FilterGroup label={t('portal:ledger.kind')}>
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
              {t('portal:ledger.kind')}
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
              {t('portal:ledger.mergeNote')}
            </span>
          </div>
        </div>
        {download.isError ? (
          <div
            role="alert"
            className="flex items-center gap-3 rounded-lg border border-err/30 bg-err/5 px-3.5 py-2.5 text-[13px] text-err"
          >
            <span className="flex-1">
              {t('portal:ledger.exportFailed', {
                reason: exportFailure(download.error, locale),
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!canExport}
              onClick={() => download.mutate(filter)}
            >
              {t('common:action.retry')}
            </Button>
          </div>
        ) : null}
        <RefreshError title={t('portal:ledger.refreshFailed')} query={ledger} />
        {rangeIsOverlong ? (
          <div
            role="alert"
            className="rounded-lg border border-err/30 bg-err/5 px-3.5 py-3 text-[13px] text-err"
          >
            {t('portal:ledger.rangeTooLong', {
              from: range.from,
              to: range.to,
              limit: latestRangeEnd(range.from),
            })}
          </div>
        ) : null}
        {data ? (
          <div className="flex justify-between gap-x-5 gap-y-1 text-xs tabular-nums text-muted-foreground md:justify-start md:text-[13px]">
            <span>
              {t('portal:ledger.total', {
                count: data.pagination.total,
                total: data.pagination.total,
              })}
              {kind ? (
                <>
                  {t('portal:ledger.filteredTotal')}
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
              {t('portal:ledger.currentBalance')}{' '}
              <Money
                value={{ currency: data.currency, amount: data.balance }}
                className="font-semibold"
              />
            </span>
          </div>
        ) : null}
        {rangeIsOverlong ? null : ledger.isError && !data ? (
          <QueryError
            title={t('portal:ledger.loadFailed')}
            error={ledger.error}
            retrying={ledger.isFetching}
            onRetry={() => void ledger.refetch()}
          />
        ) : !data ? (
          <Skeleton
            aria-busy
            aria-label={t('portal:ledger.loading')}
            className="h-[240px] rounded-xl"
          />
        ) : data.items.length === 0 ? (
          isDefaultView ? (
            <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
              <span className="text-[15px] font-semibold">
                {t('portal:ledger.empty.title')}
              </span>
              <span className="text-[13px] text-muted-foreground">
                {t('portal:ledger.empty.body')}
              </span>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
              <span className="text-[15px] font-semibold">
                {t('portal:ledger.filteredEmpty.title')}
              </span>
              <span className="text-[13px] text-muted-foreground">
                {t('portal:ledger.filteredEmpty.range', {
                  from: formatDay(range.from, locale),
                  to:
                    locale === 'en'
                      ? formatDay(range.to, locale)
                      : range.to.slice(5),
                })}
                {kind
                  ? t('portal:ledger.filteredEmpty.kind', {
                      kind: portalLedgerKindLabel(kind, locale),
                    })
                  : ''}
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
                {t('common:action.clearFilters')}
              </Button>
            </div>
          )
        ) : (
          <>
            <LedgerTable currency={data.currency} items={data.items} />
            <LedgerCards currency={data.currency} items={data.items} />
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground tabular-nums">
              <span>
                {t('portal:ledger.range', {
                  from: (page - 1) * PORTAL_LEDGER_PAGE_SIZE + 1,
                  to: (page - 1) * PORTAL_LEDGER_PAGE_SIZE + data.items.length,
                  total: data.pagination.total,
                })}
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
