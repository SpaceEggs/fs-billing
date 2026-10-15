import { useDeferredValue, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AdminRatesResponse } from '@fs-billing/shared';
import { DateTime, Rate } from '../../../components/data-format';
import { Pagination, pageSlice } from '../../../components/pagination';
import { QueryError } from '../../../components/query-error';
import { apiQuery } from '../../../lib/admin-api';

const entriesPerPage = 100;

function rateUnit(currency: AdminRatesResponse['currency']) {
  return currency === 'CNY' ? '费率（元/分钟）' : '费率（$/分钟）';
}

/** 费率（只读）：当前版本与已排期的未来版本；导入、编辑随后续交付。 */
export function RatesTab({ tenantId }: { tenantId: string }) {
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  const rates = useQuery({
    ...apiQuery('adminRates', {
      params: { tenantId },
      query: deferred ? { search: deferred } : {},
    }),
    placeholderData: keepPreviousData,
  });
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
  const entries = data.current.entries;
  const visible = pageSlice(entries, page, entriesPerPage);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
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
          className="h-11 w-full rounded-lg border border-input bg-transparent px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9 md:w-[280px] md:text-sm"
        />
        <span className="tabular-nums">
          当前版本生效于 <DateTime value={data.current.effectiveFrom} /> ·{' '}
          {deferred ? `匹配 ${entries.length} 条` : `共 ${entries.length} 条`}
        </span>
      </div>
      {data.scheduled.length ? (
        <div
          role="note"
          className="flex flex-col gap-0.5 rounded-lg border border-brand-border bg-brand-soft px-3.5 py-2.5 text-[13px]"
        >
          <span className="font-semibold text-primary">
            已排期 {data.scheduled.length} 个未来版本
          </span>
          {data.scheduled.map((version) => (
            <span key={version.id} className="tabular-nums">
              生效于 <DateTime value={version.effectiveFrom} /> ·{' '}
              {version.entries.length} 条
            </span>
          ))}
        </div>
      ) : null}
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
                    {rateUnit(data.currency)}
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
    </div>
  );
}
