import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { UseQueryResult } from '@tanstack/react-query';
import type { Currency, PortalCdr } from '@fs-billing/shared';
import { Skeleton } from '../ui/skeleton';
import type { CdrFilters } from '../../lib/cdr-search';
import type { DayRange } from '../../lib/day-range';
import { formatDayRange } from '../../lib/format';
import { useLocale } from '../../i18n';
import { cn } from '../../lib/utils';
import { Pagination } from '../pagination';
import { QueryError, RefreshError } from '../query-error';
import { Button } from '../ui/button';
import { formatCount } from './cdr-format';
import { CdrDetailDialog, type CdrDetailExtra } from './cdr-detail';
import { CdrFilterBar, type CdrFilterExtra } from './cdr-filters';
import { CdrSummaryBar, CdrSummaryLine } from './cdr-summary';
import { CdrCards, CdrTable } from './cdr-table';

/** 门户与后台话单列表的公共响应形状；后台的汇总多一个 unverifiedCalls。 */
export type CdrListData<Row extends PortalCdr> = {
  currency: Currency;
  items: Row[];
  pagination: { page: number; pageSize: number; total: number };
  summary: {
    billedMinutes: string;
    charge: string;
    unansweredCalls: number;
    unverifiedCalls?: number;
  };
};

function CdrSkeleton() {
  const { t } = useTranslation(['common', 'cdr']);
  return (
    <div
      aria-busy
      aria-label={t('cdr:list.loading')}
      className="flex flex-col overflow-hidden rounded-xl border border-border"
    >
      {Array.from({ length: 6 }, (_, index) => (
        <div
          key={index}
          className="grid h-[42px] grid-cols-[2fr_2fr_1fr_1fr] items-center gap-3.5 border-b border-border px-3.5 last:border-b-0"
        >
          <Skeleton className="h-2.5 w-[85%] rounded" />
          <Skeleton className="h-2.5 w-[70%] rounded" />
          <Skeleton className="h-2.5 w-[60%] justify-self-end rounded" />
          <Skeleton className="h-2.5 w-[75%] justify-self-end rounded" />
        </div>
      ))}
    </div>
  );
}

function Empty({
  filtered,
  title,
  hint,
  action,
  onClear,
}: {
  filtered: boolean;
  title: string;
  hint: string;
  action?: string;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-10 text-center">
      {filtered ? (
        <span
          aria-hidden
          className="flex size-11 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground"
        >
          ⌕
        </span>
      ) : null}
      <span className="text-[15px] font-semibold">{title}</span>
      <span className="text-[13px] text-muted-foreground tabular-nums">
        {hint}
      </span>
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          {action}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * 话单列表的完整界面：筛选、汇总、表格与卡片、分页、详情。门户页和后台标签页各自负责
 * 地址状态、请求与导出，把结果交进来；后台再通过插槽加入「未经验证」的标签、筛选与说明。
 */
export function CdrExplorer<Row extends PortalCdr>({
  range,
  defaultRange,
  maxDate,
  filters,
  page,
  list,
  countries,
  inputError,
  notices,
  banner,
  summaryNote,
  filterExtra,
  filterTrailing,
  activeExtraFilters = [],
  rowBadge,
  detailExtra,
  emptyHint,
  onRange,
  onFilters,
  onPage,
}: {
  range: DayRange;
  /** 日期范围是默认的本月，空状态写「本月还没有话单」。 */
  defaultRange: boolean;
  maxDate: string;
  filters: CdrFilters;
  page: number;
  list: UseQueryResult<CdrListData<Row>>;
  countries: readonly string[];
  /** 筛选条件本身不合规（超长范围、被叫号码格式），此时不请求、不显示列表。 */
  inputError: string | null;
  /** 筛选下方的提示，如导出失败。 */
  notices?: React.ReactNode;
  banner?: React.ReactNode;
  summaryNote?:
    ((summary: CdrListData<Row>['summary']) => React.ReactNode) | undefined;
  filterExtra?: CdrFilterExtra | undefined;
  /** 电脑端筛选行最右侧的内容。 */
  filterTrailing?: React.ReactNode;
  /** 空状态里说明生效的额外筛选，如「仅看未经验证」。 */
  activeExtraFilters?: readonly string[];
  rowBadge?: ((cdr: Row) => React.ReactNode) | undefined;
  detailExtra?: ((cdr: Row) => CdrDetailExtra) | undefined;
  emptyHint?: string;
  onRange: (range: DayRange) => void;
  /** 值为 undefined 表示从地址中清除；改筛选回到第一页由调用方处理。 */
  onFilters: (patch: CdrFilters) => void;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation(['common', 'cdr']);
  const locale = useLocale();
  const [selected, setSelected] = useState<Row | null>(null);
  const data = inputError === null ? list.data : undefined;
  const status = filters.status ?? 'answered';
  const total = data?.pagination.total;
  const pageSize = data?.pagination.pageSize ?? 50;
  const conditions = [
    ...(filters.callee
      ? [t('cdr:list.conditionCallee', { callee: filters.callee })]
      : []),
    ...(filters.country
      ? [t('cdr:list.conditionCountry', { country: filters.country })]
      : []),
    ...(filters.direction
      ? [
          t('cdr:list.conditionDirection', {
            direction:
              filters.direction === 'inbound'
                ? t('cdr:direction.inbound')
                : t('cdr:direction.outbound'),
          }),
        ]
      : []),
    ...activeExtraFilters,
  ];
  const clearFilters = () =>
    onFilters({
      callee: undefined,
      country: undefined,
      direction: undefined,
      unverifiedOnly: undefined,
    });
  return (
    <div className="flex flex-col gap-4">
      <CdrFilterBar
        range={range}
        maxDate={maxDate}
        filters={filters}
        countries={countries}
        resultLabel={
          total === undefined
            ? t('cdr:list.result')
            : t('cdr:list.resultCount', { n: formatCount(total) })
        }
        extra={filterExtra}
        trailing={filterTrailing}
        onRange={onRange}
        onFilters={onFilters}
      />
      {notices}
      {inputError ? (
        <div
          role="alert"
          className="rounded-lg border border-err/30 bg-err/5 px-3.5 py-3 text-[13px] text-err"
        >
          {inputError}
        </div>
      ) : null}
      {inputError === null ? (
        <RefreshError title={t('cdr:list.refreshFailed')} query={list} />
      ) : null}
      {banner}
      {data ? (
        <>
          <CdrSummaryBar
            currency={data.currency}
            status={status}
            summary={{ total: data.pagination.total, ...data.summary }}
            extraNote={summaryNote?.(data.summary)}
          />
          <CdrSummaryLine
            currency={data.currency}
            status={status}
            rangeText={formatDayRange(range, true, locale)}
            summary={{ total: data.pagination.total, ...data.summary }}
          />
        </>
      ) : null}
      {inputError !== null ? null : list.isError && !data ? (
        <QueryError
          title={t('cdr:list.loadFailed')}
          error={list.error}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      ) : !data ? (
        <CdrSkeleton />
      ) : data.items.length === 0 && data.pagination.total > 0 ? (
        <Empty
          filtered
          title={t('cdr:list.pageEmpty')}
          hint={t('cdr:list.pageSummary', {
            total: formatCount(data.pagination.total),
            size: pageSize,
          })}
          action={t('common:action.backToFirstPage')}
          onClear={() => onPage(1)}
        />
      ) : data.items.length === 0 ? (
        <Empty
          filtered={conditions.length > 0}
          title={
            conditions.length > 0
              ? t('cdr:list.emptyFiltered')
              : defaultRange
                ? t('cdr:list.emptyThisMonth')
                : t('cdr:list.emptyRange')
          }
          hint={
            conditions.length > 0
              ? conditions.join(' · ')
              : (emptyHint ?? t('cdr:list.emptyHint'))
          }
          action={t('common:action.clearFilters')}
          onClear={clearFilters}
        />
      ) : (
        <div
          className={cn(
            'flex flex-col gap-4',
            list.isPlaceholderData && 'opacity-60',
          )}
        >
          <CdrTable
            currency={data.currency}
            items={data.items}
            onSelect={setSelected}
            badge={rowBadge}
          />
          <CdrCards
            currency={data.currency}
            items={data.items}
            onSelect={setSelected}
            badge={rowBadge}
          />
          <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground tabular-nums">
            <span>
              {data.pagination.total <= pageSize
                ? t('cdr:list.total', {
                    n: formatCount(data.pagination.total),
                  })
                : t('cdr:list.range', {
                    from: formatCount((page - 1) * pageSize + 1),
                    to: formatCount((page - 1) * pageSize + data.items.length),
                    total: formatCount(data.pagination.total),
                  })}
            </span>
            <Pagination
              page={page}
              pageSize={pageSize}
              rowCount={data.pagination.total}
              onPage={onPage}
            />
          </div>
        </div>
      )}
      <CdrDetailDialog
        cdr={selected}
        currency={data?.currency ?? 'CNY'}
        onClose={() => setSelected(null)}
        extra={detailExtra as ((cdr: PortalCdr) => CdrDetailExtra) | undefined}
      />
    </div>
  );
}
