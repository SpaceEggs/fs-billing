import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  formatCountryLabel,
  translate,
  type AdminRateEntry,
  type AdminRateVersion,
  type AdminTenantDetailResponse,
  type Locale,
} from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import {
  RateEditDialog,
  type RateEditResult,
} from '../../../components/admin/rate-edit-dialog';
import {
  CancelScheduledDialog,
  ScheduledRateVersion,
} from '../../../components/admin/scheduled-rate-version';
import { ProblemAlert } from '../../../components/admin/problem-alert';
import { RateCsvTemplateLink } from '../../../components/admin/rate-csv-template-link';
import {
  RateImportDialog,
  type RateImportBase,
} from '../../../components/admin/rate-import-dialog';
import {
  RateCopyDialog,
  type CopySide,
  type RateCopyDirection,
} from '../../../components/admin/rate-copy-dialog';
import { DateTime, Rate } from '../../../components/data-format';
import { Pagination, pageSlice } from '../../../components/pagination';
import { QueryError, RefreshError } from '../../../components/query-error';
import { Button } from '../../../components/ui/button';
import { apiKey, apiQuery, useApiMutation } from '../../../lib/admin-api';
import { downloadText } from '../../../lib/download';
import { formatDateTime, formatRate } from '../../../lib/format';
import { rateChangePercent, scheduledRowHints } from '../../../lib/rates';
import { useLocale } from '../../../i18n';
import { cn } from '../../../lib/utils';

const entriesPerPage = 100;

const rowName = (entry: AdminRateEntry) =>
  `${entry.prefix} ${formatCountryLabel(entry.country, entry.description)}`;

type Notice = { changed: boolean; text: string };

function editNotice(
  { before, after, scheduled, response }: RateEditResult,
  unit: string,
  locale: Locale,
): Notice {
  const name = rowName(after);
  if (response.auditId === null)
    return {
      changed: false,
      text: translate(locale, 'tenant:rates.noticeUnchanged', { name }),
    };
  const rate = `${formatRate(after.rate)} ${unit}`;
  if (scheduled)
    return {
      changed: true,
      text: translate(locale, 'tenant:rates.noticeScheduled', {
        name,
        time: formatDateTime(response.version.effectiveFrom, locale),
        rate,
      }),
    };
  const percent = rateChangePercent(before.rate, after.rate);
  return {
    changed: true,
    text: translate(locale, 'tenant:rates.noticeChanged', {
      name,
      rate,
      percent: percent
        ? translate(locale, 'tenant:rates.percent', { percent: percent.text })
        : '',
    }),
  };
}

/** 生效时刻之后再取，留出与服务端时钟的偏差。 */
const activationMarginMs = 1000;
/** 到点后服务端仍列为排定（时钟偏差）时，隔这么久再取一次，直到它成为当前版本。 */
const activationRetryMs = 10_000;
/** setTimeout 的上限约 24.8 天，更远的生效时间分段等待。 */
const maxTimeoutMs = 2 ** 31 - 1;

/**
 * 页面一直停留时，排定版本到点生效不会触发任何请求；在最早的生效时刻刷新该租户的费率查询，
 * 当前版本、排定卡片和导入/编辑的禁用状态随之更新。每次刷新完成（含失败）后重新安排，
 * 仍有到点的排定版本时每 `activationRetryMs` 再取一次。
 */
function useRefetchAtActivation(
  tenantId: string,
  scheduled: readonly AdminRateVersion[] | undefined,
  fetchedAt: number,
) {
  const queryClient = useQueryClient();
  const [wake, setWake] = useState(0);
  const next = scheduled?.length
    ? Math.min(...scheduled.map((version) => Date.parse(version.effectiveFrom)))
    : null;
  useEffect(() => {
    if (next === null) return;
    let active = true;
    const wait = next + activationMarginMs - Date.now();
    const timer = setTimeout(
      () => {
        if (Date.now() < next + activationMarginMs) setWake((n) => n + 1);
        else
          // 刷新失败时 `fetchedAt` 不变，完成后无论成败都重新安排，否则停在旧版本上。
          void queryClient
            .invalidateQueries({
              queryKey: apiKey('adminRates', { params: { tenantId } }),
            })
            .finally(() => {
              if (active) setWake((n) => n + 1);
            });
      },
      wait > 0 ? Math.min(wait, maxTimeoutMs) : activationRetryMs,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [next, fetchedAt, wake, queryClient, tenantId]);
}

/** 只供脚本聚焦、不进 Tab 顺序（写在函数外：money lint 把 RatesTab 里的负数当作费率运算）。 */
const scriptFocusOnly = -1;

/**
 * 费率（设计稿第二批 §7、§8、§10）：当前版本、排定的新版本与取消、单条编辑、导入与导出 CSV。
 * 手机只能查看和搜索（pages.md §3.6）。
 */
export function RatesTab({ tenant }: { tenant: AdminTenantDetailResponse }) {
  const { t } = useTranslation(['tenant', 'format', 'common', 'rates']);
  const locale = useLocale();
  const tenantId = tenant.id;
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  // 打开时连同所据版本一起取快照：后台刷新不能把旧草稿换到新版本上提交（乐观并发，冲突应得 409）。
  const [editing, setEditing] = useState<{
    baseVersionId: string;
    entry: AdminRateEntry;
  } | null>(null);
  const [cancelling, setCancelling] = useState<AdminRateVersion | null>(null);
  const [importing, setImporting] = useState<RateImportBase | null>(null);
  const [copying, setCopying] = useState<{
    direction: RateCopyDirection;
    self: CopySide;
  } | null>(null);
  const importBlockedId = useId();
  // 排定导入后「导入 CSV」随即禁用，关闭对话框时焦点退到这里。
  const sectionRef = useRef<HTMLElement>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const rates = useQuery({
    ...apiQuery('adminRates', {
      params: { tenantId },
      query: deferred ? { search: deferred } : {},
    }),
    placeholderData: keepPreviousData,
  });
  // 排定版本的变动须比较完整表，搜索时另取未过滤的结果（与无搜索时共用缓存）。
  const full = useQuery(
    apiQuery('adminRates', { params: { tenantId }, query: {} }),
  );
  useRefetchAtActivation(tenantId, full.data?.scheduled, full.dataUpdatedAt);
  const exportCsv = useApiMutation('adminRateExport');
  const data = rates.data;
  if (rates.isError && !data)
    return (
      <QueryError
        title={t('tenant:rates.loadFailed')}
        error={rates.error}
        retrying={rates.isFetching}
        onRetry={() => void rates.refetch()}
      />
    );
  if (!data)
    return (
      <Skeleton
        aria-busy
        aria-label={t('tenant:rates.loading')}
        className="h-[240px] rounded-xl"
      />
    );
  const unit = t(
    data.currency === 'CNY' ? 'format:rateUnit.cny' : 'format:rateUnit.usd',
  );
  const entries = data.current.entries;
  const visible = pageSlice(entries, page, entriesPerPage);
  const currentId = data.current.id;
  const versions = full.data ? [full.data.current, ...full.data.scheduled] : [];
  const hasScheduled = versions.length > 1;
  const rowHints =
    full.data && versions[1]
      ? scheduledRowHints(full.data.current.entries, versions[1])
      : new Map<string, string>();
  const emptyTable = entries.length === 0 && !deferred;

  function openImport() {
    if (!full.data) return;
    setNotice(null);
    setImporting({
      versionId: full.data.current.id,
      entryCount: full.data.current.entries.length,
      hasScheduled: full.data.scheduled.length > 0,
    });
  }
  const importButton = (
    <Button
      className="hidden md:inline-flex"
      disabled={!full.data || hasScheduled}
      aria-describedby={hasScheduled ? importBlockedId : undefined}
      onClick={openImport}
    >
      {t('tenant:rates.importCsv')}
    </Button>
  );

  function openCopy(direction: RateCopyDirection) {
    if (!full.data) return;
    setNotice(null);
    setCopying({
      direction,
      self: {
        tenant: {
          id: tenantId,
          code: tenant.code,
          name: tenant.name,
          currency: full.data.currency,
        },
        versionId: full.data.current.id,
        entryCount: full.data.current.entries.length,
        hasScheduled: full.data.scheduled.length > 0,
      },
    });
  }

  async function download(versionId: string) {
    setNotice(null);
    try {
      const result = await exportCsv.mutateAsync({
        params: { tenantId },
        body: { versionId, locale },
      });
      downloadText(result.filename, result.csv, 'text/csv;charset=utf-8');
    } catch {
      // 失败说明由 exportCsv.error 显示。
    }
  }

  return (
    <section
      ref={sectionRef}
      tabIndex={scriptFocusOnly}
      aria-label={t('tenant:rates.tableAria')}
      className="flex flex-col gap-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      {/* 无搜索时两个查询同一缓存，只提示一次。 */}
      <RefreshError
        title={t('tenant:rates.refreshFailed')}
        query={rates.isError ? rates : full}
      />
      {versions.slice(1).map((version, index) => (
        <ScheduledRateVersion
          key={version.id}
          version={version}
          previous={versions[index]!}
          currency={data.currency}
          exporting={exportCsv.isPending}
          onExport={() => void download(version.id)}
          onCancel={() => {
            setNotice(null);
            setCancelling(version);
          }}
        />
      ))}
      <div className="flex flex-col gap-0.5 rounded-[10px] border border-brand-border bg-brand-soft px-3.5 py-3 text-sm md:hidden">
        <span className="font-semibold text-primary">
          {t('tenant:rates.mobileOnlyTitle')}
        </span>
        <span className="text-[13px] text-muted-foreground">
          {t('tenant:rates.mobileOnlyBody')}
        </span>
      </div>
      {notice ? (
        <div
          role="status"
          className={cn(
            'flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]',
            notice.changed
              ? 'border-ok-border bg-ok-soft text-ok'
              : 'border-border bg-muted text-muted-foreground',
          )}
        >
          <span className="flex-1">{notice.text}</span>
          <Button
            variant="link"
            size="inline"
            onClick={() => setNotice(null)}
            className="text-[13px] text-current"
          >
            {t('common:ui.close')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3 text-[13px] text-muted-foreground">
        <Input
          type="search"
          aria-label={t('tenant:rates.search')}
          placeholder={t('tenant:rates.search')}
          maxLength={200}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="sm:h-11 sm:text-base md:h-9 md:w-[260px] md:text-sm"
        />
        <Badge variant="ok" className="hidden h-6 md:inline-flex">
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          {t('tenant:rates.currentVersion')}
        </Badge>
        <span className="w-full text-xs tabular-nums max-md:order-first md:hidden">
          {deferred
            ? t('tenant:rates.currentVersionMatches', { count: entries.length })
            : t('tenant:rates.currentVersionCount', {
                count: entries.length,
              })}
        </span>
        <span className="hidden tabular-nums md:inline">
          {t('tenant:rates.effectiveFromPrefix')}
          <DateTime value={data.current.effectiveFrom} /> ·{' '}
          {deferred
            ? t('tenant:rates.matches', { count: entries.length })
            : t('tenant:rates.entries', { count: entries.length })}{' '}
          · {t('tenant:rates.longestPrefix')}
        </span>
        <span className="hidden flex-1 md:block" />
        {emptyTable ? null : (
          <Button
            variant="outline"
            className="hidden md:inline-flex"
            disabled={!full.data}
            onClick={() => openCopy('push')}
          >
            {t('tenant:rates.copyToOther')}
          </Button>
        )}
        <Button
          variant="outline"
          className="hidden md:inline-flex"
          disabled={exportCsv.isPending}
          onClick={() => void download(currentId)}
        >
          {t('tenant:rates.exportCsv')}
        </Button>
        {emptyTable ? null : importButton}
        {hasScheduled ? (
          <span
            id={importBlockedId}
            className="hidden w-full text-right text-xs md:block"
          >
            {t('rates:import.blocked')}
          </span>
        ) : null}
      </div>
      {exportCsv.error ? <ProblemAlert error={exportCsv.error} /> : null}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
          <span className="text-[15px] font-semibold">
            {deferred
              ? t('tenant:rates.noMatchTitle')
              : t('tenant:rates.emptyTitle')}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {deferred
              ? t('tenant:rates.noMatchHint')
              : t('tenant:rates.emptyHint', { currency: data.currency })}
          </span>
          {emptyTable ? (
            <div className="mt-2 hidden flex-col items-center gap-2 md:flex">
              <div className="flex gap-2">
                {importButton}
                <Button
                  variant="outline"
                  disabled={!full.data || hasScheduled}
                  aria-describedby={hasScheduled ? importBlockedId : undefined}
                  onClick={() => openCopy('pull')}
                >
                  {t('tenant:rates.copyOther')}
                </Button>
              </div>
              <RateCsvTemplateLink />
            </div>
          ) : null}
        </div>
      ) : (
        <>
          {/* 手机（第二批 1c/7c）同一张表排成每行带单位的列表，不显示表头。 */}
          <div className="overflow-x-auto rounded-xl border border-border md:rounded-[10px]">
            <Table>
              <TableHeader className="hidden md:table-header-group">
                <TableRow className="border-t-0 whitespace-nowrap">
                  <TableHead className="px-4">{t('rates:field.iso')}</TableHead>
                  <TableHead>{t('tenant:rates.country')}</TableHead>
                  <TableHead>{t('tenant:rates.prefix')}</TableHead>
                  <TableHead>{t('tenant:rates.description')}</TableHead>
                  <TableHead className="px-4 text-right">
                    {t('tenant:rates.rateWithUnit', { unit })}
                  </TableHead>
                  <TableHead className="font-bold text-center hidden w-20 px-4 md:table-cell">
                    <span className="sr-only">{t('tenant:rates.actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody className="tabular-nums">
                {visible.map((entry) => {
                  const hint = rowHints.get(entry.prefix);
                  return (
                    <TableRow
                      key={entry.prefix}
                      className={cn(
                        'border-t-0',
                        'flex min-h-[52px] items-center gap-2.5 px-3.5 py-2.5 not-first:border-t md:table-row md:border-t md:p-0',
                        hint && 'bg-brand-soft',
                      )}
                    >
                      <TableCell className="p-0 hidden font-mono md:table-cell md:px-4 md:py-2.5">
                        {entry.iso}
                      </TableCell>
                      <TableCell className="p-0 hidden md:table-cell md:px-3 md:py-2.5">
                        {entry.country}
                      </TableCell>
                      <TableCell className="p-0 min-w-10 font-mono font-semibold md:px-3 md:py-2.5 md:font-normal">
                        {entry.prefix}
                      </TableCell>
                      <TableCell className="p-0 hidden md:table-cell md:px-3 md:py-2.5">
                        {entry.description}
                      </TableCell>
                      <TableCell className="p-0 flex-1 text-sm md:hidden">
                        {formatCountryLabel(entry.country, entry.description)}
                      </TableCell>
                      <TableCell className="p-0 text-right md:px-4 md:py-2.5">
                        <span className="text-sm font-medium md:text-[13px] md:font-normal">
                          <Rate value={entry.rate} />
                          <span className="ml-[3px] text-[11px] font-normal text-muted-foreground md:hidden">
                            {unit}
                          </span>
                        </span>
                        {hint ? (
                          <span className="block text-[11px] text-primary">
                            {hint}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="hidden px-4 py-2.5 text-right md:table-cell">
                        {/* G4：已有排定版本时不能单条编辑，提示与导入按钮共用。 */}
                        <Button
                          variant="link"
                          size="inline"
                          aria-label={t('tenant:rates.editFor', {
                            name: rowName(entry),
                          })}
                          disabled={hasScheduled}
                          aria-describedby={
                            hasScheduled ? importBlockedId : undefined
                          }
                          onClick={() => {
                            setNotice(null);
                            setEditing({ baseVersionId: currentId, entry });
                          }}
                          className="text-[13px] underline-offset-[3px] disabled:cursor-not-allowed disabled:text-muted-foreground"
                        >
                          {t('tenant:rates.edit')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <Pagination
            page={page}
            pageSize={entriesPerPage}
            rowCount={entries.length}
            onPage={setPage}
          />
        </>
      )}
      {editing ? (
        <RateEditDialog
          tenant={{ id: tenantId, code: tenant.code, currency: data.currency }}
          baseVersionId={editing.baseVersionId}
          entry={editing.entry}
          hasScheduled={hasScheduled}
          fallbackFocus={sectionRef}
          onClose={() => setEditing(null)}
          onDone={(result) => {
            setEditing(null);
            setNotice(editNotice(result, unit, locale));
          }}
        />
      ) : null}
      {importing ? (
        <RateImportDialog
          tenant={{
            id: tenantId,
            code: tenant.code,
            name: tenant.name,
            currency: data.currency,
          }}
          base={importing}
          onClose={() => setImporting(null)}
          fallbackFocus={sectionRef}
        />
      ) : null}
      {copying ? (
        <RateCopyDialog
          direction={copying.direction}
          self={copying.self}
          onClose={() => setCopying(null)}
          fallbackFocus={sectionRef}
        />
      ) : null}
      {cancelling ? (
        <CancelScheduledDialog
          tenantId={tenantId}
          version={cancelling}
          onClose={() => setCancelling(null)}
          onDone={(changed) => {
            setCancelling(null);
            setNotice({
              changed,
              text: changed
                ? t('tenant:rates.cancelled')
                : t('tenant:rates.cancelUnchanged'),
            });
          }}
        />
      ) : null}
    </section>
  );
}
