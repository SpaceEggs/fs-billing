import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  formatCountryLabel,
  type AdminRateEntry,
  type AdminRateVersion,
  type AdminTenantDetailResponse,
} from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Input } from '../../../components/ui/input';
import { Badge } from '../../../components/ui/badge';
import {
  RateEditDialog,
  rateUnit,
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
import { cn } from '../../../lib/utils';

const entriesPerPage = 100;

const rowName = (entry: AdminRateEntry) =>
  `${entry.prefix} ${formatCountryLabel(entry.country, entry.description)}`;

type Notice = { changed: boolean; text: string };

function editNotice(
  { before, after, scheduled, response }: RateEditResult,
  unit: string,
): Notice {
  const name = rowName(after);
  if (response.auditId === null)
    return { changed: false, text: `${name} 没有变更` };
  const rate = `${formatRate(after.rate)} ${unit}`;
  if (scheduled)
    return {
      changed: true,
      text: `已排定：${name} 将于 ${formatDateTime(response.version.effectiveFrom)} 起改为 ${rate}，已记入操作日志`,
    };
  const percent = rateChangePercent(before.rate, after.rate);
  return {
    changed: true,
    text: `${name} 费率已改为 ${rate}${percent ? `（${percent.text}）` : ''}，已记入操作日志`,
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
        title="费率表加载失败"
        error={rates.error}
        retrying={rates.isFetching}
        onRetry={() => void rates.refetch()}
      />
    );
  if (!data)
    return (
      <Skeleton
        aria-busy
        aria-label="费率表加载中"
        className="h-[240px] rounded-xl"
      />
    );
  const unit = rateUnit[data.currency];
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
      导入 CSV
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
        body: { versionId },
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
      aria-label="费率表"
      className="flex flex-col gap-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
    >
      {/* 无搜索时两个查询同一缓存，只提示一次。 */}
      <RefreshError
        title="费率表刷新失败，显示的可能不是最新"
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
        <span className="font-semibold text-primary">请在电脑上操作</span>
        <span className="text-[13px] text-muted-foreground">
          导入、复制费率表涉及大量明细核对，手机上仅支持查看和搜索。
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
            关闭
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3 text-[13px] text-muted-foreground">
        <Input
          type="search"
          aria-label="搜索前缀、ISO、国家或说明"
          placeholder="搜索前缀、ISO、国家或说明"
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
          当前生效版本
        </Badge>
        <span className="w-full text-xs tabular-nums max-md:order-first md:hidden">
          当前生效版本 ·{' '}
          {deferred ? `匹配 ${entries.length} 条` : `${entries.length} 条`}
        </span>
        <span className="hidden tabular-nums md:inline">
          自 <DateTime value={data.current.effectiveFrom} /> ·{' '}
          {deferred ? `匹配 ${entries.length} 条` : `${entries.length} 条`} ·
          最长前缀优先匹配
        </span>
        <span className="hidden flex-1 md:block" />
        {emptyTable ? null : (
          <Button
            variant="outline"
            className="hidden md:inline-flex"
            disabled={!full.data}
            onClick={() => openCopy('push')}
          >
            复制到其他租户
          </Button>
        )}
        <Button
          variant="outline"
          className="hidden md:inline-flex"
          disabled={exportCsv.isPending}
          onClick={() => void download(currentId)}
        >
          导出 CSV
        </Button>
        {emptyTable ? null : importButton}
        {hasScheduled ? (
          <span
            id={importBlockedId}
            className="hidden w-full text-right text-xs md:block"
          >
            已有排定的新版本，请先取消排定
          </span>
        ) : null}
      </div>
      {exportCsv.error ? <ProblemAlert error={exportCsv.error} /> : null}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
          <span className="text-[15px] font-semibold">
            {deferred ? '没有匹配的费率' : '费率表为空'}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {deferred
              ? '请换一个前缀、ISO、国家或说明'
              : `导入 CSV，或复制一个同币种（${data.currency}）租户的费率表作为起点`}
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
                  复制其他租户的费率表
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
            <table className="w-full border-collapse text-[13px]">
              <thead className="hidden md:table-header-group">
                <tr className="bg-muted text-xs whitespace-nowrap text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">ISO</th>
                  <th className="px-3 py-2.5 text-left font-medium">国家</th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    号码前缀
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">说明</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    费率（{unit}）
                  </th>
                  <th className="hidden w-20 px-4 py-2.5 md:table-cell">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {visible.map((entry) => {
                  const hint = rowHints.get(entry.prefix);
                  return (
                    <tr
                      key={entry.prefix}
                      className={cn(
                        'flex min-h-[52px] items-center gap-2.5 border-border px-3.5 py-2.5 not-first:border-t md:table-row md:border-t md:p-0',
                        hint && 'bg-brand-soft',
                      )}
                    >
                      <td className="hidden font-mono md:table-cell md:px-4 md:py-2.5">
                        {entry.iso}
                      </td>
                      <td className="hidden md:table-cell md:px-3 md:py-2.5">
                        {entry.country}
                      </td>
                      <td className="min-w-10 font-mono font-semibold md:px-3 md:py-2.5 md:font-normal">
                        {entry.prefix}
                      </td>
                      <td className="hidden md:table-cell md:px-3 md:py-2.5">
                        {entry.description}
                      </td>
                      <td className="flex-1 text-sm md:hidden">
                        {formatCountryLabel(entry.country, entry.description)}
                      </td>
                      <td className="text-right md:px-4 md:py-2.5">
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
                      </td>
                      <td className="hidden px-4 py-2.5 text-right md:table-cell">
                        {/* G4：已有排定版本时不能单条编辑，提示与导入按钮共用。 */}
                        <Button
                          variant="link"
                          size="inline"
                          aria-label={`编辑 ${rowName(entry)}`}
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
                          编辑
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
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
            setNotice(editNotice(result, unit));
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
                ? '已取消排定的新版本，已记入操作日志'
                : '该版本已不在排定中，没有变更',
            });
          }}
        />
      ) : null}
    </section>
  );
}
