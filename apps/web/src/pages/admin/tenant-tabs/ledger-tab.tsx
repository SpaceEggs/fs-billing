import { useId } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  adminLedgerKindSchema,
  type AdminLedgerEntry,
  type Currency,
} from '@fs-billing/shared';
import { DateTime, Money } from '../../../components/data-format';
import { Pagination } from '../../../components/pagination';
import { QueryError, RefreshError } from '../../../components/query-error';
import { Select } from '../../../components/ui/select';
import { StatusTag, type StatusKey } from '../../../components/status-tag';
import { apiQuery } from '../../../lib/admin-api';
import type { LedgerSearch } from '../../../lib/admin-search';
import { ledgerKindLabels } from '../../../lib/balance-operation';
import { formatDateTime } from '../../../lib/format';
import { cn } from '../../../lib/utils';

const ledgerPageSize = 25;

/**
 * 北京时间日期（YYYY-MM-DD）转成接口的闭区间 from/to，空的一端不限。
 * occurred_at 精确到微秒，结束端取当天最后一微秒，避免漏掉 23:59:59.999 之后的流水。
 */
export function beijingDayRange(range: { from: string; to: string }) {
  return {
    ...(range.from ? { from: `${range.from}T00:00:00.000000+08:00` } : {}),
    ...(range.to ? { to: `${range.to}T23:59:59.999999+08:00` } : {}),
  };
}

const paymentTags = {
  pending: 'unpaid',
  received: 'paid',
  voided: 'voided',
} as const satisfies Record<
  NonNullable<AdminLedgerEntry['paymentStatus']>,
  StatusKey
>;

/** 人工余额操作按输入精度显示（调账可到 4 位小数）；通话扣费仍按 2 位舍入。 */
const exactAmount = (entry: AdminLedgerEntry) => entry.kind !== 'call_charge';

function PaymentStatus({ entry }: { entry: AdminLedgerEntry }) {
  return entry.paymentStatus ? (
    <StatusTag status={paymentTags[entry.paymentStatus]} />
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function Note({ entry }: { entry: AdminLedgerEntry }) {
  return (
    <span className="flex items-center gap-2">
      <span className={entry.note ? undefined : 'text-muted-foreground'}>
        {entry.note || '—'}
      </span>
      {entry.noteVisibility === 'admin' ? (
        <span className="rounded bg-muted px-1.5 py-px text-[11px] whitespace-nowrap text-muted-foreground">
          仅内部可见
        </span>
      ) : null}
    </span>
  );
}

function LedgerTable({
  currency,
  items,
}: {
  currency: Currency;
  items: AdminLedgerEntry[];
}) {
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="bg-muted text-xs whitespace-nowrap text-muted-foreground">
            <th className="px-4 py-2.5 text-left font-medium">时间</th>
            <th className="px-3 py-2.5 text-left font-medium">类型</th>
            <th className="px-3 py-2.5 text-right font-medium">金额</th>
            <th className="px-3 py-2.5 text-right font-medium">变动后余额</th>
            <th className="px-3 py-2.5 text-left font-medium">收款状态</th>
            <th className="px-3 py-2.5 text-left font-medium">备注</th>
            <th className="px-4 py-2.5 text-left font-medium">操作人</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {items.map((entry) => (
            <tr key={entry.id} className="border-t border-border">
              <td className="px-4 py-2.5 whitespace-nowrap">
                <DateTime value={entry.occurredAt} />
              </td>
              <td className="px-3 py-2.5 whitespace-nowrap">
                {ledgerKindLabels[entry.kind]}
              </td>
              <td className="px-3 py-2.5 text-right font-semibold whitespace-nowrap">
                <Money
                  value={{ currency, amount: entry.amount }}
                  tone="signed"
                  exact={exactAmount(entry)}
                />
              </td>
              <td className="px-3 py-2.5 text-right whitespace-nowrap">
                <Money value={{ currency, amount: entry.balanceAfter }} />
              </td>
              <td className="px-3 py-2 whitespace-nowrap">
                <PaymentStatus entry={entry} />
              </td>
              <td className="px-3 py-2.5">
                <Note entry={entry} />
              </td>
              <td className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                {entry.actor?.name ?? '系统'}
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
  items: AdminLedgerEntry[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((entry) => (
        <li
          key={entry.id}
          className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3 tabular-nums"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[15px] font-medium">
              {ledgerKindLabels[entry.kind]}
              {entry.paymentStatus ? (
                <StatusTag
                  status={paymentTags[entry.paymentStatus]}
                  className="h-5 px-1.5 text-[11px]"
                />
              ) : null}
            </span>
            <Money
              value={{ currency, amount: entry.amount }}
              tone="signed"
              exact={exactAmount(entry)}
              className="text-[15px] font-semibold"
            />
          </div>
          <div className="flex justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">
              {formatDateTime(entry.occurredAt).slice(5, 16)} ·{' '}
              {entry.note || '—'}
              {entry.noteVisibility === 'admin' ? '（仅内部可见）' : ''}
            </span>
            <span className="whitespace-nowrap">
              余额 <Money value={{ currency, amount: entry.balanceAfter }} />
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * 余额流水（设计稿第一批 2a/2b）：按时间倒序分页，可按北京时间日期范围（含两端）与类型筛选。
 * 契约没有收款状态筛选和流水导出，设计稿中的这两项省略。
 */
export function LedgerTab({ tenantId }: { tenantId: string }) {
  const kindId = useId();
  const rangeErrorId = useId();
  const search = useSearch({ from: '/admin/tenants/$tenantId' });
  const navigate = useNavigate({ from: '/admin/tenants/$tenantId' });
  const { kind, page = 1 } = search;
  const range = { from: search.from ?? '', to: search.to ?? '' };
  /** 值为 undefined 表示从地址中清除。 */
  const update = (patch: LedgerSearch) =>
    void navigate({
      search: (current) => ({ ...current, ...patch }),
      replace: true,
    });
  /** 改筛选回到第一页。 */
  const setFilter = (patch: Omit<LedgerSearch, 'page'>) =>
    update({ ...patch, page: undefined });
  const rangeInvalid =
    range.from !== '' && range.to !== '' && range.from > range.to;
  const ledger = useQuery({
    ...apiQuery('adminTenantLedger', {
      params: { tenantId },
      query: {
        page,
        pageSize: ledgerPageSize,
        ...(kind ? { kind } : {}),
        ...(rangeInvalid ? {} : beijingDayRange(range)),
      },
    }),
    placeholderData: keepPreviousData,
  });
  const data = ledger.data;
  const filtered = kind !== undefined || range.from !== '' || range.to !== '';
  const dateClass =
    'h-full min-w-0 flex-1 bg-transparent text-base tabular-nums outline-none md:w-[124px] md:flex-none md:text-sm';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div
          role="group"
          aria-label="日期范围（北京时间）"
          aria-describedby={rangeInvalid ? rangeErrorId : undefined}
          className={cn(
            'flex h-11 w-full items-center gap-2 rounded-lg border border-input px-3 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 md:h-9 md:w-auto',
            rangeInvalid && 'border-err',
          )}
        >
          <input
            type="date"
            aria-label="开始日期"
            value={range.from}
            max={range.to || undefined}
            onChange={(event) =>
              setFilter({ from: event.target.value || undefined })
            }
            className={dateClass}
          />
          <span aria-hidden className="text-muted-foreground">
            —
          </span>
          <input
            type="date"
            aria-label="结束日期"
            value={range.to}
            min={range.from || undefined}
            onChange={(event) =>
              setFilter({ to: event.target.value || undefined })
            }
            className={dateClass}
          />
        </div>
        <label htmlFor={kindId} className="sr-only">
          类型
        </label>
        <Select
          id={kindId}
          value={kind ?? ''}
          onChange={(event) =>
            setFilter({
              kind: adminLedgerKindSchema.safeParse(event.target.value).data,
            })
          }
        >
          <option value="">全部类型</option>
          {adminLedgerKindSchema.options.map((option) => (
            <option key={option} value={option}>
              {ledgerKindLabels[option]}
            </option>
          ))}
        </Select>
        {rangeInvalid ? (
          <span id={rangeErrorId} role="alert" className="text-xs text-err">
            开始日期不能晚于结束日期
          </span>
        ) : data ? (
          <span className="text-[13px] text-muted-foreground tabular-nums">
            共 {data.pagination.total} 条
          </span>
        ) : null}
      </div>
      <RefreshError title="余额流水刷新失败，列表可能不是最新" query={ledger} />
      {ledger.isError && !data ? (
        <QueryError
          title="余额流水加载失败"
          error={ledger.error}
          retrying={ledger.isFetching}
          onRetry={() => void ledger.refetch()}
        />
      ) : !data ? (
        <div
          aria-busy
          aria-label="余额流水加载中"
          className="h-[240px] animate-pulse rounded-xl bg-skeleton"
        />
      ) : data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
          <span className="text-[15px] font-semibold">
            {filtered
              ? `没有符合条件的${kind ? ledgerKindLabels[kind] : ''}流水`
              : '暂无余额流水'}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {filtered
              ? '请调整日期范围或类型'
              : '充值、赊账、赠送、调账和通话扣费都会记录在这里'}
          </span>
        </div>
      ) : (
        <>
          <LedgerTable currency={data.currency} items={data.items} />
          <LedgerCards currency={data.currency} items={data.items} />
          <Pagination
            page={page}
            pageSize={ledgerPageSize}
            rowCount={data.pagination.total}
            onPage={(next) => update({ page: next > 1 ? next : undefined })}
          />
        </>
      )}
    </div>
  );
}
