import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  adminLedgerKindSchema,
  beijingDateOf,
  isDayRangeWithinOneMonth,
  latestRangeEnd,
  type AdminLedgerRow,
  type Currency,
} from '@fs-billing/shared';
import { Skeleton } from '../../../components/ui/skeleton';
import { Label } from '../../../components/ui/label';
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
import { ledgerKindLabel } from '../../../lib/balance-operation';
import { rangeOrMonthToDate } from '../../../lib/day-range';
import {
  formatLedgerChargeNote,
  formatShortDateTime,
} from '../../../lib/format';
import { useLocale } from '../../../i18n';

const ledgerPageSize = 25;

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
  const { t } = useTranslation(['admin']);
  const locale = useLocale();
  if (entry.kind === 'call_charge')
    return <span>{formatLedgerChargeNote(entry, locale)}</span>;
  return (
    <span className="flex items-center gap-2">
      <span className={entry.note ? undefined : 'text-muted-foreground'}>
        {entry.note || '—'}
      </span>
      {entry.noteVisibility === 'admin' ? (
        <span className="rounded bg-muted px-1.5 py-px text-[11px] whitespace-nowrap text-muted-foreground">
          {t('admin:balanceDialog.visibilityAdmin')}
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
  const { t } = useTranslation(['tenant']);
  const locale = useLocale();
  return (
    <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
      <Table>
        <TableHeader>
          <TableRow className="border-t-0 whitespace-nowrap">
            <TableHead className="px-4">{t('tenant:ledger.time')}</TableHead>
            <TableHead>{t('tenant:ledger.kind')}</TableHead>
            <TableHead className="text-right">
              {t('tenant:ledger.amount')}
            </TableHead>
            <TableHead className="text-right">
              {t('tenant:ledger.balanceAfter')}
            </TableHead>
            <TableHead>{t('tenant:ledger.paymentStatus')}</TableHead>
            <TableHead>{t('tenant:ledger.note')}</TableHead>
            <TableHead className="px-4">{t('tenant:ledger.actor')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody className="tabular-nums">
          {items.map((entry) => (
            <TableRow
              key={
                entry.kind === 'call_charge'
                  ? `${entry.kind}:${entry.day}`
                  : entry.id
              }
            >
              <TableCell className="px-4 py-2.5 whitespace-nowrap">
                <DateTime value={entry.occurredAt} />
              </TableCell>
              <TableCell className="py-2.5 whitespace-nowrap">
                {ledgerKindLabel(entry.kind, locale)}
              </TableCell>
              <TableCell className="py-2.5 text-right font-semibold whitespace-nowrap">
                <Money
                  value={{ currency, amount: entry.amount }}
                  tone="signed"
                  exact={exactAmount(entry)}
                />
              </TableCell>
              <TableCell className="py-2.5 text-right whitespace-nowrap">
                <Money value={{ currency, amount: entry.balanceAfter }} />
              </TableCell>
              <TableCell className="py-2 whitespace-nowrap">
                <PaymentStatus entry={entry} />
              </TableCell>
              <TableCell className="py-2.5">
                <Note entry={entry} />
              </TableCell>
              <TableCell className="px-4 py-2.5 whitespace-nowrap text-muted-foreground">
                {entry.kind === 'call_charge' ? '—' : entry.actor.name}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
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
  const { t } = useTranslation(['tenant', 'admin']);
  const locale = useLocale();
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
              {ledgerKindLabel(entry.kind, locale)}
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
              {formatShortDateTime(entry.occurredAt, locale, false)} ·{' '}
              {entry.kind === 'call_charge'
                ? formatLedgerChargeNote(entry, locale)
                : entry.note || '—'}
              {entry.kind !== 'call_charge' && entry.noteVisibility === 'admin'
                ? t('admin:balanceDialog.internalVisibility')
                : ''}
            </span>
            <span className="whitespace-nowrap">
              {t('tenant:ledger.balanceSuffix')}{' '}
              <Money value={{ currency, amount: entry.balanceAfter }} />
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {t('tenant:ledger.actor')}{' '}
            {entry.kind === 'call_charge' ? '—' : entry.actor.name}
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
  const { t } = useTranslation(['tenant']);
  const locale = useLocale();
  const kindChoices = [
    { value: undefined, label: t('tenant:ledger.allKinds') },
    ...adminLedgerKindSchema.options.map((value) => ({
      value,
      label: ledgerKindLabel(value, locale),
    })),
  ];
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
          label={t('tenant:ledger.dateRange')}
          value={range}
          max={beijingDateOf(now)}
          maxRangeEndForStart={latestRangeEnd}
          onChange={(next) => setFilter(next)}
          className="min-w-0 flex-1 md:w-[260px] md:flex-none"
        />
        <FilterSheet
          activeCount={kind ? 1 : 0}
          resultLabel={resultLabel(
            data?.pagination.total,
            t('tenant:ledger.resultUnit'),
            locale,
          )}
          onClear={() => setFilter({ kind: undefined })}
        >
          <FilterGroup label={t('tenant:ledger.type')}>
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
          <Label htmlFor={kindId} className="sr-only">
            {t('tenant:ledger.type')}
          </Label>
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
              {t('tenant:ledger.total', { count: data.pagination.total })}
            </span>
          ) : null}
        </div>
      </div>
      <RefreshError title={t('tenant:ledger.refreshFailed')} query={ledger} />
      {rangeIsOverlong ? (
        <div
          role="alert"
          className="rounded-lg border border-err/30 bg-err/5 px-3.5 py-3 text-[13px] text-err"
        >
          {t('tenant:ledger.rangeOverlong', {
            from: range.from,
            to: range.to,
            limit: latestRangeEnd(range.from),
          })}
        </div>
      ) : null}
      {data ? (
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] tabular-nums text-muted-foreground">
          <span>
            {t('tenant:ledger.currentBalance')}{' '}
            <Money value={{ currency: data.currency, amount: data.balance }} />
          </span>
          <span>
            {t('tenant:ledger.filteredAmount')}{' '}
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
          title={t('tenant:ledger.loadFailed')}
          error={ledger.error}
          retrying={ledger.isFetching}
          onRetry={() => void ledger.refetch()}
        />
      ) : !data ? (
        <Skeleton
          aria-busy
          aria-label={t('tenant:ledger.loading')}
          className="h-[240px] rounded-xl"
        />
      ) : data.items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-[10px] border border-border px-5 py-14 text-center">
          <span className="text-[15px] font-semibold">
            {kind
              ? t('tenant:ledger.emptyFor', {
                  kind: ledgerKindLabel(kind, locale),
                })
              : t('tenant:ledger.emptyAll')}
          </span>
          <span className="text-[13px] text-muted-foreground">
            {t('tenant:ledger.emptyHint')}
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
