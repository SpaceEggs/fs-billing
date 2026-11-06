import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import {
  beijingDateOf,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  translate,
  type Identity,
} from '@fs-billing/shared';
import { AppShell, PageBody } from '../../components/app-shell';
import { CdrExplorer } from '../../components/cdr/cdr-explorer';
import {
  CdrExportButton,
  CdrExportError,
  CdrExportIcon,
  useCdrExport,
} from '../../components/cdr/cdr-export';
import { useLocale } from '../../i18n';
import { apiQuery } from '../../lib/admin-api';
import { callDownload } from '../../lib/api';
import {
  calleeProblem,
  cdrListQuery,
  type CdrFilters,
  type PortalCdrsSearch,
} from '../../lib/cdr-search';
import { beijingMonthToDate, rangeOrMonthToDate } from '../../lib/day-range';

/**
 * 客户门户话单（设计稿客户门户第一批 2a 至 2g）：日期范围、被叫号码、国家、接通状态都写入地址，
 * 刷新与登录过期后保留；列表、汇总、国家选项和导出都只带这些筛选，租户来自会话。
 */
export function PortalCdrsPage({ identity }: { identity: Identity }) {
  const { t } = useTranslation(['portal', 'common']);
  const locale = useLocale();
  const search = useSearch({ from: '/portal/portal/cdrs' });
  const navigate = useNavigate({ from: '/portal/cdrs' });
  const { callee, country, status, direction, page = 1 } = search;
  const filters: CdrFilters = { callee, country, status, direction };
  const now = new Date();
  const range = rangeOrMonthToDate(search, now);
  const defaultRange =
    range.from === beijingMonthToDate(now).from &&
    range.to === beijingMonthToDate(now).to;
  const rangeIsOverlong = !isDayRangeWithinOneMonth(range.from, range.to);
  const inputError = rangeIsOverlong
    ? t('portal:cdrs.rangeTooLong', {
        from: range.from,
        to: range.to,
        limit: latestRangeEnd(range.from),
      })
    : calleeProblem(filters.callee);
  const query = cdrListQuery(range, filters);
  const list = useQuery({
    ...apiQuery('portalCdrs', { query: { ...query, page } }),
    enabled: inputError === null,
    placeholderData: keepPreviousData,
  });
  const countries = useQuery({
    ...apiQuery('portalCdrCountries', { query: range }),
    enabled: !rangeIsOverlong,
    placeholderData: keepPreviousData,
  });
  const exporter = useCdrExport(
    () => callDownload('portalCdrsExport', { body: query }),
    JSON.stringify(query),
  );
  const exportNow = () => exporter.mutate();
  /** 值为 undefined 表示从地址中清除。 */
  const update = (patch: PortalCdrsSearch) =>
    void navigate({
      search: (current) => ({ ...current, ...patch }),
      replace: true,
    });
  /** 改筛选回到第一页。 */
  const setFilter = (patch: Omit<PortalCdrsSearch, 'page'>) =>
    update({ ...patch, page: undefined });
  return (
    <AppShell
      identity={identity}
      title={t('portal:cdrs.title')}
      crumb={
        identity.kind === 'customer'
          ? `${identity.tenant.code} · ${identity.tenant.name}`
          : ''
      }
      activeNav={translate('zh', 'shell:nav.cdrs')}
      mobileActions={
        <CdrExportIcon
          exporting={exporter.isPending}
          disabled={inputError !== null}
          onExport={exportNow}
        />
      }
    >
      <PageBody
        title={t('portal:cdrs.title')}
        actions={
          <CdrExportButton
            label={t('portal:cdrs.exportLabel')}
            exporting={exporter.isPending}
            disabled={inputError !== null}
            onExport={exportNow}
          />
        }
      >
        <CdrExplorer
          range={range}
          defaultRange={defaultRange}
          maxDate={beijingDateOf(now)}
          filters={filters}
          page={page}
          list={list}
          countries={countries.data?.countries ?? []}
          inputError={inputError}
          banner={
            locale === 'en' ? (
              <p className="m-0 text-xs text-muted-foreground">
                {t('portal:cdrs.timezone')}
              </p>
            ) : null
          }
          notices={
            <CdrExportError
              error={exporter.error}
              retrying={exporter.isPending}
              onRetry={exportNow}
            />
          }
          onRange={(next) => setFilter(next)}
          onFilters={setFilter}
          onPage={(next) => update({ page: next > 1 ? next : undefined })}
        />
      </PageBody>
    </AppShell>
  );
}
