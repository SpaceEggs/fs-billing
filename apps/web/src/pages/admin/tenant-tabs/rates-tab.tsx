import { useDeferredValue, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AdminRateEntry,
  AdminRateVersion,
  AdminTenantDetailResponse,
} from '@fs-billing/shared';
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
import { DateTime, Rate } from '../../../components/data-format';
import { Pagination, pageSlice } from '../../../components/pagination';
import { QueryError } from '../../../components/query-error';
import { Button } from '../../../components/ui/button';
import { apiQuery, useApiMutation } from '../../../lib/admin-api';
import { downloadText } from '../../../lib/download';
import { formatDateTime, formatRate } from '../../../lib/format';
import { rateChangePercent } from '../../../lib/rates';
import { cn } from '../../../lib/utils';

const entriesPerPage = 100;

type Notice = { changed: boolean; text: string };

function editNotice(
  { before, after, scheduled, response }: RateEditResult,
  unit: string,
): Notice {
  const name = `${after.prefix} ${after.country}`;
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

/**
 * 费率（设计稿第二批 §7、§8）：当前版本、排定的新版本与取消、单条编辑、导出当前版本。
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
      <div
        aria-busy
        aria-label="费率表加载中"
        className="h-[240px] animate-pulse rounded-xl bg-skeleton"
      />
    );
  const unit = rateUnit[data.currency];
  const entries = data.current.entries;
  const visible = pageSlice(entries, page, entriesPerPage);
  const currentId = data.current.id;
  const versions = full.data ? [full.data.current, ...full.data.scheduled] : [];

  async function download() {
    setNotice(null);
    try {
      const result = await exportCsv.mutateAsync({
        params: { tenantId },
        body: { versionId: currentId },
      });
      downloadText(result.filename, result.csv, 'text/csv;charset=utf-8');
    } catch {
      // 失败说明由 exportCsv.error 显示。
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {versions.slice(1).map((version, index) => (
        <ScheduledRateVersion
          key={version.id}
          version={version}
          previous={versions[index]!}
          currency={data.currency}
          onCancel={() => {
            setNotice(null);
            setCancelling(version);
          }}
        />
      ))}
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
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="rounded text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
          >
            关闭
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-3 text-[13px] text-muted-foreground">
        <input
          type="search"
          aria-label="搜索前缀或国家"
          placeholder="搜索前缀或国家"
          maxLength={200}
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(1);
          }}
          className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9 md:w-[260px] md:text-sm"
        />
        <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-ok-border bg-ok-soft px-2 text-xs font-medium text-ok">
          <span aria-hidden className="size-1.5 rounded-full bg-current" />
          当前生效版本
        </span>
        <span className="tabular-nums">
          自 <DateTime value={data.current.effectiveFrom} /> ·{' '}
          {deferred ? `匹配 ${entries.length} 条` : `${entries.length} 条`} ·
          最长前缀优先匹配
        </span>
        <span className="flex-1" />
        <Button
          variant="outline"
          className="hidden md:inline-flex"
          disabled={exportCsv.isPending}
          onClick={() => void download()}
        >
          导出 CSV
        </Button>
      </div>
      {exportCsv.error ? <ProblemAlert error={exportCsv.error} /> : null}
      {entries.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
          <span className="text-[15px] font-semibold">
            {deferred ? '没有匹配的费率' : '费率表为空'}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {deferred
              ? '请换一个前缀或国家名称'
              : '没有费率时该租户的呼叫无法计费'}
          </span>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-[10px] border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-muted text-xs whitespace-nowrap text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">前缀</th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    国家/备注
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    费率（{unit}）
                  </th>
                  <th className="hidden w-20 px-4 py-2.5 md:table-cell">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {visible.map((entry) => (
                  <tr key={entry.prefix} className="border-t border-border">
                    <td className="px-4 py-2.5 font-mono">{entry.prefix}</td>
                    <td className="px-3 py-2.5">{entry.country}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Rate value={entry.rate} />
                    </td>
                    <td className="hidden px-4 py-2.5 text-right md:table-cell">
                      <button
                        type="button"
                        aria-label={`编辑 ${entry.prefix} ${entry.country}`}
                        onClick={() => {
                          setNotice(null);
                          setEditing({ baseVersionId: currentId, entry });
                        }}
                        className="rounded text-[13px] text-primary underline-offset-[3px] outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring"
                      >
                        编辑
                      </button>
                    </td>
                  </tr>
                ))}
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
          hasScheduled={versions.length > 1}
          onClose={() => setEditing(null)}
          onDone={(result) => {
            setEditing(null);
            setNotice(editNotice(result, unit));
          }}
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
    </div>
  );
}
