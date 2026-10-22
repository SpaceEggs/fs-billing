import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  type AdminTenantDetailResponse,
} from '@fs-billing/shared';
import {
  UnverifiedBadge,
  UnverifiedBanner,
  unverifiedDetail,
  unverifiedFilter,
  unverifiedSummaryNote,
} from '../../../components/admin/cdr-unverified';
import { CdrExplorer } from '../../../components/cdr/cdr-explorer';
import {
  CdrExportButton,
  CdrExportError,
  useCdrExport,
} from '../../../components/cdr/cdr-export';
import { apiQuery } from '../../../lib/admin-api';
import { callDownload } from '../../../lib/api';
import type { TenantDetailSearch } from '../../../lib/admin-search';
import {
  calleeProblem,
  cdrListQuery,
  type CdrFilters,
} from '../../../lib/cdr-search';
import { beijingMonthToDate, rangeOrMonthToDate } from '../../../lib/day-range';
import { formatDate } from '../../../lib/format';

type CdrsSearch = Pick<
  TenantDetailSearch,
  keyof CdrFilters | 'cdrFrom' | 'cdrTo' | 'page'
>;

/**
 * 租户话单（设计稿管理后台第三批 1b 至 1e、3b 至 3e）：与客户门户同一套话单组件，另有「未经验证」
 * 标签、「仅看未经验证」筛选、详情里的验证状态，导出会写操作日志。
 * 阶段 8 的「删除话单」与阶段 9 的「查看告警」未开发，不显示（决定 15）。
 */
export function CdrsTab({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const search = useSearch({ from: '/admin/tenants/$tenantId' });
  const navigate = useNavigate({ from: '/admin/tenants/$tenantId' });
  const { callee, country, status, unverifiedOnly, page = 1 } = search;
  const filters: CdrFilters = { callee, country, status, unverifiedOnly };
  const now = new Date();
  // 话单标签页的日期范围与余额流水分开：地址里是 cdrFrom / cdrTo。
  const range = rangeOrMonthToDate(
    { from: search.cdrFrom, to: search.cdrTo },
    now,
  );
  const monthToDate = beijingMonthToDate(now);
  const rangeIsOverlong = !isDayRangeWithinOneMonth(range.from, range.to);
  const inputError = rangeIsOverlong
    ? `日期范围超出一个月上限：${range.from} 至 ${range.to}。结束日期不能晚于 ${latestRangeEnd(range.from)}。`
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
      label="导出 CSV"
      exporting={exporter.isPending}
      disabled={inputError !== null}
      onExport={exportNow}
      {...(className ? { className } : {})}
    />
  );
  return (
    <div className="flex flex-col gap-4">
      <CdrExplorer
        range={range}
        defaultRange={
          range.from === monthToDate.from && range.to === monthToDate.to
        }
        maxDate={formatDate(now)}
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
          unverifiedOnly && list.data ? (
            <UnverifiedBanner total={list.data.pagination.total} />
          ) : null
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
        filterTrailing={exportButton()}
        activeExtraFilters={unverifiedOnly ? ['仅看未经验证'] : []}
        rowBadge={(cdr) => <UnverifiedBadge cdr={cdr} />}
        detailExtra={unverifiedDetail}
        emptyHint={`该租户创建于 ${formatDate(tenant.createdAt)}，请调整日期范围`}
        onRange={(next) => setFilter({ cdrFrom: next.from, cdrTo: next.to })}
        onFilters={setFilter}
        onPage={(next) => update({ page: next > 1 ? next : undefined })}
      />
      <div className="md:hidden">{exportButton('h-11 w-full')}</div>
    </div>
  );
}
