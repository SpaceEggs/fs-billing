import { useId } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  adminLedgerKindSchema,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  type AdminLedgerRow,
  type Currency,
} from '@fs-billing/shared';
import { formatMergedChargeNote } from '@fs-billing/shared';
import { DateTime, Money } from '../../../components/data-format';
import { DateRangeField } from '../../../components/date-range-field';
import {
  ChoiceGrid,
  FilterGroup,
  FilterSheet,
  resultLabel,
} from '../../../components/filter-sheet';
import { Pagination } from '../../../components/pagination';
import { QueryError, RefreshError } from '../../../components/query-error';
import {
  NativeSelect,
  NativeSelectOption,
} from '../../../components/ui/native-select';
import { StatusTag, type StatusKey } from '../../../components/status-tag';
import { apiQuery } from '../../../lib/admin-api';
import type { LedgerSearch } from '../../../lib/admin-search';
import { ledgerKindLabels } from '../../../lib/balance-operation';
import { rangeOrMonthToDate } from '../../../lib/day-range';
import { formatDate, formatDateTime } from '../../../lib/format';

const ledgerPageSize = 25;

const kindChoices = [
  { value: undefined, label: '全部类型' },
  ...adminLedgerKindSchema.options.map((value) => ({
    value,
    label: ledgerKindLabels[value],
  })),
];

const paymentTags = {
  pending: 'unpaid',
  received: 'paid',
  voided: 'voided',
} as const satisfies Record<
  NonNullable<
    Extract<AdminLedgerRow, { kind: 'credit_recharge' }>['paymentStatus']
  >,
  StatusKey
>;

/** 人工余额操作按输入精度显示（调账可到 4 位小数）；通话扣费仍按 2 位舍入。 */
const exactAmount = (entry: AdminLedgerRow) => entry.kind !== 'call_charge';

function PaymentStatus({ entry }: { entry: AdminLedgerRow }) {
  if (entry.kind === 'call_charge')
    return <span className="text-muted-foreground">—</span>;
  return entry.paymentStatus ? (
    <StatusTag status={paymentTags[entry.paymentStatus]} />
  ) : (
    <span className="text-muted-foreground">—</span>
  );
}

function Note({ entry }: { entry: AdminLedgerRow }) {
  if (entry.kind === 'call_charge')
    return <span>{formatMergedChargeNote(entry)}</span>;
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
  items: AdminLedgerRow[];
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
            <tr
              key={
                entry.kind === 'call_charge'
                  ? `${entry.kind}:${entry.day}`
                  : entry.id
              }
              className="border-t border-border"
            >
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
                {entry.kind === 'call_charge' ? '—' : entry.actor.name}
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
  items: AdminLedgerRow[];
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0 md:hidden">
      {items.map((entry) => (
        <li
          key={
            entry.kind === 'call_charge'
              ? `${entry.kind}:${entry.day}`
              : entry.id
          }
          className="flex flex-col gap-1.5 rounded-[10px] border border-border px-3.5 py-3 tabular-nums"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 text-[15px] font-medium">
              {ledgerKindLabels[entry.kind]}
              {entry.kind === 'call_charge' ? (
                <span className="text-muted-foreground">—</span>
              ) : entry.paymentStatus ? (
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
              {entry.kind === 'call_charge'
                ? formatMergedChargeNote(entry)
                : entry.note || '—'}
              {entry.kind !== 'call_charge' && entry.noteVisibility === 'admin'
                ? '（仅内部可见）'
                : ''}
            </span>
            <span className="whitespace-nowrap">
              余额 <Money value={{ currency, amount: entry.balanceAfter }} />
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            操作人 {entry.kind === 'call_charge' ? '—' : entry.actor.name}
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * 余额流水（设计稿第一批 2a/2b）：按时间倒序分页，按北京时间日期范围（含两端，默认本月 1 日到今天）与类型筛选。
 * 手机上类型放进「筛选」面板。契约没有收款状态筛选和流水导出，设计稿中的这两项省略。
 */
export function LedgerTab({ tenantId }: { tenantId: string }) {
  const kindId = useId();
  const search = useSearch({ from: '/admin/tenants/$tenantId' });
  const navigate = useNavigate({ from: '/admin/tenants/$tenantId' });
  const { kind, page = 1 } = search;
  const now = new Date();
  const range = rangeOrMonthToDate(search, now);
  const rangeIsOverlong = !isDayRangeWithinOneMonth(range.from, range.to);
  /** 值为 undefined 表示从地址中清除。 */
  const update = (patch: LedgerSearch) =>
    void navigate({
      search: (current) => ({ ...current, ...patch }),
      replace: true,
    });
  /** 改筛选回到第一页。 */
  const setFilter = (patch: Omit<LedgerSearch, 'page'>) =>
    update({ ...patch, page: undefined });
  const ledger = useQuery({
    ...apiQuery('adminTenantLedger', {
      params: { tenantId },
      query: {
        page,
        pageSize: ledgerPageSize,
        ...(kind ? { kind } : {}),
        ...range,
      },
    }),
    enabled: !rangeIsOverlong,
    placeholderData: keepPreviousData,
  });
  const data = rangeIsOverlong ? undefined : ledger.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <DateRangeField
          label="日期范围（北京时间）"
          value={range}
          max={formatDate(now)}
          maxRangeEndForStart={latestRangeEnd}
          onChange={(next) => setFilter(next)}
          className="min-w-0 flex-1 md:w-[260px] md:flex-none"
        />
        <FilterSheet
          activeCount={kind ? 1 : 0}
          resultLabel={resultLabel(data?.pagination.total, '条')}
          onClear={() => setFilter({ kind: undefined })}
        >
          <FilterGroup label="类型">
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
          <label htmlFor={kindId} className="sr-only">
            类型
          </label>
          <NativeSelect
            id={kindId}
            value={kind ?? ''}
            onChange={(event) =>
              setFilter({
                kind: adminLedgerKindSchema.safeParse(event.target.value).data,
              })
            }
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
          {data ? (
            <span className="text-[13px] text-muted-foreground tabular-nums">
              共 {data.pagination.total} 条
            </span>
          ) : null}
        </div>
      </div>
      <RefreshError title="余额流水刷新失败，列表可能不是最新" query={ledger} />
      {rangeIsOverlong ? (
        <div
          role="alert"
          className="rounded-lg border border-err/30 bg-err/5 px-3.5 py-3 text-[13px] text-err"
        >
          日期范围超出一个月上限：{range.from} 至 {range.to}。结束日期不能晚于{' '}
          {latestRangeEnd(range.from)}。
        </div>
      ) : null}
      {data ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] tabular-nums text-muted-foreground">
          <span>
            当前余额{' '}
            <Money value={{ currency: data.currency, amount: data.balance }} />
          </span>
          <span>
            筛选金额合计{' '}
            <Money
              value={{ currency: data.currency, amount: data.totalAmount }}
              tone="signed"
              exact
            />
          </span>
        </div>
      ) : null}
      {rangeIsOverlong ? null : ledger.isError && !data ? (
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
            {`该日期范围内没有${kind ? ledgerKindLabels[kind] : '余额'}流水`}
          </span>
          <span className="text-[13px] text-muted-foreground">
            充值、赊账、赠送、调账和通话扣费都会记录在这里，可调整日期范围或类型
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
