import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  beijingDateOf,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  translate,
  type AdminDeletedMonth,
  type AdminTenantDetailResponse,
  type Locale,
} from '@fs-billing/shared';
import { CdrDeleteDialog } from '../../../components/admin/cdr-delete-dialog';
import {
  UnverifiedBadge,
  UnverifiedBanner,
  unverifiedDetail,
  unverifiedFilter,
  unverifiedSummaryNote,
} from '../../../components/admin/cdr-unverified';
import { formatCount } from '../../../components/cdr/cdr-format';
import { CdrExplorer } from '../../../components/cdr/cdr-explorer';
import {
  CdrExportButton,
  CdrExportError,
  useCdrExport,
} from '../../../components/cdr/cdr-export';
import { Button } from '../../../components/ui/button';
import { apiQuery } from '../../../lib/admin-api';
import { callDownload } from '../../../lib/api';
import type { TenantDetailSearch } from '../../../lib/admin-search';
import {
  calleeProblem,
  cdrListQuery,
  type CdrFilters,
} from '../../../lib/cdr-search';
import { beijingMonthToDate, rangeOrMonthToDate } from '../../../lib/day-range';
import { formatDate, formatDateTime } from '../../../lib/format';
import { statementMonthTitle } from '../../../lib/statement';
import { useLocale } from '../../../i18n';
import { cn } from '../../../lib/utils';

type CdrsSearch = Pick<
  TenantDetailSearch,
  keyof CdrFilters | 'cdrFrom' | 'cdrTo' | 'page'
>;

/**
 * 租户话单（设计稿管理后台第三批 1b 至 1e、3b 至 3e）：与客户门户同一套话单组件，另有「未经验证」
 * 标签、「仅看未经验证」筛选、详情里的验证状态，导出会写操作日志。
 * 「删除话单」按整月删除已结束且账单已生成的月份（决定 15：当月、无账单月、已删除月不可选）。
 * 范围内已删除的月份在列表上方提示（决定 12）。阶段 9 的「查看告警」未开发，不显示。
 */
export function CdrsTab({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const { t } = useTranslation(['tenant']);
  const locale = useLocale();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const search = useSearch({ from: '/admin/tenants/$tenantId' });
  const navigate = useNavigate({ from: '/admin/tenants/$tenantId' });
  const {
    callee,
    country,
    status,
    direction,
    unverifiedOnly,
    page = 1,
  } = search;
  const filters: CdrFilters = {
    callee,
    country,
    status,
    direction,
    unverifiedOnly,
  };
  const now = new Date();
  // 话单标签页的日期范围与余额流水分开：地址里是 cdrFrom / cdrTo。
  const range = rangeOrMonthToDate(
    { from: search.cdrFrom, to: search.cdrTo },
    now,
  );
  const monthToDate = beijingMonthToDate(now);
  const rangeIsOverlong = !isDayRangeWithinOneMonth(range.from, range.to);
  const inputError = rangeIsOverlong
    ? t('tenant:cdrs.rangeOverlong', {
        from: range.from,
        to: range.to,
        limit: latestRangeEnd(range.from),
      })
    : calleeProblem(callee);
  const params = { tenantId: tenant.id };
  const query = {
    ...cdrListQuery(range, filters),
    ...(unverifiedOnly ? { unverifiedOnly: true } : {}),
  };
  const list = useQuery({
    ...apiQuery('adminTenantCdrs', { params, query: { ...query, page } }),
    enabled: inputError === null,
    placeholderData: keepPreviousData,
  });
  const countries = useQuery({
    ...apiQuery('adminTenantCdrCountries', { params, query: range }),
    enabled: !rangeIsOverlong,
    placeholderData: keepPreviousData,
  });
  const exporter = useCdrExport(
    () => callDownload('adminTenantCdrsExport', { params, body: query }),
    JSON.stringify(query),
  );
  const exportNow = () => exporter.mutate();
  /** 值为 undefined 表示从地址中清除。 */
  const update = (patch: CdrsSearch) =>
    void navigate({
      search: (current) => ({ ...current, ...patch }),
      replace: true,
    });
  /** 改筛选回到第一页。 */
  const setFilter = (patch: Omit<CdrsSearch, 'page'>) =>
    update({ ...patch, page: undefined });
  const exportButton = (className?: string) => (
    <CdrExportButton
      label={t('tenant:cdrs.exportCsv')}
      exporting={exporter.isPending}
      disabled={inputError !== null}
      onExport={exportNow}
      {...(className ? { className } : {})}
    />
  );
  const deleteButton = (className?: string) => (
    <Button
      variant="destructive"
      className={cn('border-err-border', className)}
      onClick={() => setDeleteOpen(true)}
    >
      {t('tenant:cdrs.delete')}
    </Button>
  );
  const deletedMonths = list.data?.deletedMonths ?? [];
  const unverifiedBanner =
    unverifiedOnly && list.data ? (
      <UnverifiedBanner total={list.data.pagination.total} />
    ) : null;
  const deletedBanner =
    deletedMonths.length > 0 ? (
      <DeletedMonthsBanner months={deletedMonths} />
    ) : null;
  return (
    <div className="flex flex-col gap-4">
      <CdrExplorer
        range={range}
        defaultRange={
          range.from === monthToDate.from && range.to === monthToDate.to
        }
        maxDate={beijingDateOf(now)}
        filters={filters}
        page={page}
        list={list}
        countries={countries.data?.countries ?? []}
        inputError={inputError}
        notices={
          <CdrExportError
            error={exporter.error}
            retrying={exporter.isPending}
            onRetry={exportNow}
          />
        }
        banner={
          deletedBanner && unverifiedBanner ? (
            <div className="flex flex-col gap-2">
              {deletedBanner}
              {unverifiedBanner}
            </div>
          ) : (
            (deletedBanner ?? unverifiedBanner)
          )
        }
        summaryNote={(summary) =>
          unverifiedSummaryNote(
            summary.unverifiedCalls ?? 0,
            list.data?.pagination.total ?? 0,
          )
        }
        filterExtra={unverifiedFilter(unverifiedOnly === true, (checked) =>
          setFilter({ unverifiedOnly: checked ? true : undefined }),
        )}
        filterTrailing={
          <div className="flex gap-2">
            {exportButton()}
            {deleteButton()}
          </div>
        }
        activeExtraFilters={
          unverifiedOnly ? [t('tenant:cdrs.unverifiedOnly')] : []
        }
        rowBadge={(cdr) => <UnverifiedBadge cdr={cdr} />}
        detailExtra={unverifiedDetail}
        emptyHint={t('tenant:cdrs.emptyHint', {
          date: formatDate(tenant.createdAt, locale),
        })}
        onRange={(next) => setFilter({ cdrFrom: next.from, cdrTo: next.to })}
        onFilters={setFilter}
        onPage={(next) => update({ page: next > 1 ? next : undefined })}
      />
      <div className="flex flex-col gap-2 md:hidden">
        {exportButton('h-11 w-full')}
        {deleteButton('h-11 w-full')}
      </div>
      <CdrDeleteDialog
        tenant={tenant}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      />
    </div>
  );
}

/** 旧标志没有条数、操作人或时间时只写月份（PR 4 偏差 4）。三列都在才写完整一行。 */
function deletedMonthLine(row: AdminDeletedMonth, locale: Locale) {
  const title = translate(locale, 'tenant:cdrs.deletedTitle', {
    month: statementMonthTitle(row.month, locale),
  });
  if (row.count === null || row.deletedBy === null || row.deletedAt === null)
    return title;
  return translate(locale, 'tenant:cdrs.deletedLine', {
    title,
    count: formatCount(row.count),
    name: row.deletedBy.name,
    time: formatDateTime(row.deletedAt, locale, false),
  });
}

function DeletedMonthsBanner({
  months,
}: {
  months: readonly AdminDeletedMonth[];
}) {
  const { t } = useTranslation(['tenant']);
  const locale = useLocale();
  return (
    <div
      role="region"
      aria-label={t('tenant:cdrs.deletedAria')}
      className="flex flex-col gap-1 rounded-lg border border-border bg-muted px-3.5 py-2.5 text-[13px] leading-normal text-muted-foreground"
    >
      {months.map((row) => (
        <p key={row.month} className="m-0">
          {deletedMonthLine(row, locale)}
        </p>
      ))}
    </div>
  );
}
