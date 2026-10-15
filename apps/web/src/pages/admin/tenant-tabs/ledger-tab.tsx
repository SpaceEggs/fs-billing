import { useId, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  adminLedgerKindSchema,
  type AdminLedgerEntry,
  type AdminLedgerKind,
  type Currency,
} from '@fs-billing/shared';
import { DateTime, Money } from '../../../components/data-format';
import { Pagination } from '../../../components/pagination';
import { QueryError } from '../../../components/query-error';
import { StatusTag, type StatusKey } from '../../../components/status-tag';
import { apiQuery } from '../../../lib/admin-api';
import { ledgerKindLabels } from '../../../lib/balance-operation';
import { formatDateTime } from '../../../lib/format';

const ledgerPageSize = 25;

const paymentTags = {
  pending: 'unpaid',
  received: 'paid',
  voided: 'voided',
} as const satisfies Record<
  NonNullable<AdminLedgerEntry['paymentStatus']>,
  StatusKey
>;

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

/** 余额流水（设计稿第一批 2a/2b）：按时间倒序分页，可按类型筛选。 */
export function LedgerTab({ tenantId }: { tenantId: string }) {
  const kindId = useId();
  const [kind, setKind] = useState<AdminLedgerKind | undefined>();
  const [page, setPage] = useState(1);
  const ledger = useQuery({
    ...apiQuery('adminTenantLedger', {
      params: { tenantId },
      query: {
        page,
        pageSize: ledgerPageSize,
        ...(kind ? { kind } : {}),
      },
    }),
    placeholderData: keepPreviousData,
  });
  const data = ledger.data;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label htmlFor={kindId} className="sr-only">
          类型
        </label>
        <select
          id={kindId}
          value={kind ?? ''}
          onChange={(event) => {
            setKind(adminLedgerKindSchema.safeParse(event.target.value).data);
            setPage(1);
          }}
          className="h-11 rounded-lg border border-input bg-background px-3 text-base md:h-9 md:text-sm"
        >
          <option value="">全部类型</option>
          {adminLedgerKindSchema.options.map((option) => (
            <option key={option} value={option}>
              {ledgerKindLabels[option]}
            </option>
          ))}
        </select>
        {data ? (
          <span className="text-[13px] text-muted-foreground tabular-nums">
            共 {data.pagination.total} 条
          </span>
        ) : null}
      </div>
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
            {kind ? `没有${ledgerKindLabels[kind]}流水` : '暂无余额流水'}
          </span>
          <span className="text-[13px] text-muted-foreground">
            充值、赊账、赠送、调账和通话扣费都会记录在这里
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
            onPage={setPage}
          />
        </>
      )}
    </div>
  );
}
