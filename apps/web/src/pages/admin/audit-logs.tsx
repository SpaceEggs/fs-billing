import { useEffect, useId, useState, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  auditLabelSchema,
  auditLabelText,
  type AdminAuditLog,
  type Identity,
} from '@fs-billing/shared';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import { Skeleton } from '../../components/ui/skeleton';
import { Label } from '../../components/ui/label';
import { Badge } from '../../components/ui/badge';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateRangeField } from '../../components/date-range-field';
import { DateTime } from '../../components/data-format';
import { FilterSheet, resultLabel } from '../../components/filter-sheet';
import { Pagination } from '../../components/pagination';
import { QueryError, RefreshError } from '../../components/query-error';
import { Button } from '../../components/ui/button';
import {
  NativeSelect,
  NativeSelectOption,
} from '../../components/ui/native-select';
import { apiQuery, send } from '../../lib/admin-api';
import type { AuditLogSearch } from '../../lib/admin-search';
import type { DayRange } from '../../lib/day-range';
import { formatDate, formatDateTime } from '../../lib/format';
import {
  adminNames,
  directoryCap,
  directoryCapped,
  directoryPageSize,
} from '../../lib/receivables';
import { cn } from '../../lib/utils';

const pageSize = 50;
const directoryPages = directoryCap / directoryPageSize;
const directoryCapHint = `仅显示前 ${directoryCap} 个，更多请在地址栏按 ID 筛选`;

type OpTone = 'err' | 'warn' | 'info';

type DirectoryTenant = { id: string; code: string; name: string };

type TenantDirectory = { items: DirectoryTenant[]; capped: boolean };

type OpenIds = ReadonlySet<string>;

// 决定 43 / 设计稿 opTone：删除话单红，调账与赊账充值橙，其余蓝。
// 标签 balance 合并了充值、赠送、调账和赊账，所以按 action 上色。
function toneOf(action: AdminAuditLog['action']): OpTone {
  if (action === 'cdr_delete') return 'err';
  if (action === 'balance_adjustment' || action === 'balance_credit_topup')
    return 'warn';
  return 'info';
}

const toneVariant = {
  err: 'error',
  warn: 'warning',
  info: 'brand',
} as const satisfies Record<OpTone, string>;

const changeFieldText = {
  name: '名称',
  status: '状态',
  overdraftLimit: '透支额度',
  lowBalanceThreshold: '余额提醒阈值',
  emails: '通知邮箱',
  contactName: '联系人',
  contactPhone: '电话',
  remark: '备注',
  email: '邮箱',
  prefix: '前缀',
  country: '国家',
  rate: '费率',
  amount: '金额',
  receivedOn: '收款日期',
  code: '编码',
  currency: '币种',
  balance: '余额',
  callCount: '条数',
  alertRecipients: '告警接收邮箱',
  digestMinutes: '汇总间隔（分钟）',
} as const satisfies Record<AdminAuditLog['changes'][number]['field'], string>;

const targetKindText = {
  tenant: '租户',
  portal_account: '门户账号',
  ledger_entry: '余额流水',
  rate_version: '费率表',
  receivable: '待收款',
  admin: '管理员',
  statement: '账单',
  unassigned_batch: '未归属批次',
  alert_settings: '告警设置',
} as const satisfies Record<
  NonNullable<AdminAuditLog['target']>['kind'],
  string
>;

function actorText(actor: AdminAuditLog['actor']) {
  return actor.kind === 'admin' ? actor.name : actor.label;
}

function objectText(row: AdminAuditLog) {
  if (row.tenant) return row.tenant.code;
  if (row.target) return targetKindText[row.target.kind];
  return '—';
}

function changeText(value: AdminAuditLog['changes'][number]['before']) {
  if (value === null) return '—';
  if (Array.isArray(value)) return value.length === 0 ? '—' : value.join('、');
  return value === '' ? '—' : value;
}

function countLabel(page: number, rowCount: number) {
  const text = rowCount.toLocaleString('en-US');
  if (rowCount <= pageSize) return `共 ${text} 条`;
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, rowCount);
  return `共 ${text} 条 · 第 ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')} 条`;
}

function kept(search: AuditLogSearch): AuditLogSearch {
  return {
    ...(search.from ? { from: search.from } : {}),
    ...(search.to ? { to: search.to } : {}),
    ...(search.adminId ? { adminId: search.adminId } : {}),
    ...(search.label ? { label: search.label } : {}),
    ...(search.tenantId ? { tenantId: search.tenantId } : {}),
    ...(search.page && search.page > 1 ? { page: search.page } : {}),
  };
}

function filterSummary(
  search: AuditLogSearch,
  admins: Map<string, string> | undefined,
  tenants: readonly DirectoryTenant[] | undefined,
  range: DayRange | undefined,
) {
  const parts: string[] = [];
  if (search.adminId) {
    const name = admins?.get(search.adminId);
    parts.push(name ? `管理员：${name}` : '管理员');
  }
  if (search.label) parts.push(`操作：${auditLabelText[search.label]}`);
  if (search.tenantId) {
    const code = tenants?.find((tenant) => tenant.id === search.tenantId)?.code;
    parts.push(code ? `租户：${code}` : '租户');
  }
  // 单端或被丢掉的日期以响应里的实际范围为准，不用地址栏猜「最近 30 天」。
  parts.push(range ? `${range.from} — ${range.to}` : '最近 30 天');
  return parts.join(' · ');
}

function useAuditSearch() {
  const search = useSearch({ from: '/admin/audit-logs' });
  const navigate = useNavigate({ from: '/admin/audit-logs' });
  const update = (next: AuditLogSearch) =>
    void navigate({ search: kept(next), replace: true });
  return { search, update };
}

function useTenantDirectory() {
  return useQuery({
    queryKey: ['api', 'adminTenants', 'directory'],
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TenantDirectory> => {
      const items: DirectoryTenant[] = [];
      let total = 0;
      for (let page = 1; page <= directoryPages; page += 1) {
        const result = await send('adminTenants', {
          query: { page, pageSize: directoryPageSize },
        });
        total = result.pagination.total;
        for (const tenant of result.items)
          items.push({
            id: tenant.id,
            code: tenant.code,
            name: tenant.name,
          });
        if (page * result.pagination.pageSize >= result.pagination.total) break;
      }
      return { items, capped: directoryCapped(items.length, total) };
    },
  });
}

/** 操作日志（pages.md §3.12，决定 43）：四个筛选、可展开的修改前后、50 条一页，只读。 */
export function AdminAuditLogsPage({ identity }: { identity: Identity }) {
  const { search, update } = useAuditSearch();
  const page = search.page ?? 1;
  const query = {
    page,
    pageSize,
    ...(search.from ? { from: search.from } : {}),
    ...(search.to ? { to: search.to } : {}),
    ...(search.adminId ? { adminId: search.adminId } : {}),
    ...(search.label ? { label: search.label } : {}),
    ...(search.tenantId ? { tenantId: search.tenantId } : {}),
  };
  const logs = useQuery({
    ...apiQuery('adminAuditLogs', { query }),
    placeholderData: keepPreviousData,
  });
  const admins = useQuery(adminNames);
  const tenants = useTenantDirectory();
  const filterKey = [
    search.from ?? '',
    search.to ?? '',
    search.adminId ?? '',
    search.label ?? '',
    search.tenantId ?? '',
    page,
  ].join('\0');
  const [seenFilter, setSeenFilter] = useState(filterKey);
  const [openIds, setOpenIds] = useState<OpenIds>(new Set());
  if (seenFilter !== filterKey) {
    setSeenFilter(filterKey);
    setOpenIds(new Set());
  }

  const rowCount = logs.data?.pagination.total;
  const lastPage = Math.max(1, Math.ceil((rowCount ?? 0) / pageSize));
  const pastLastPage =
    logs.data !== undefined &&
    !logs.isPlaceholderData &&
    logs.data.items.length === 0 &&
    page > lastPage;
  useEffect(() => {
    if (pastLastPage)
      update({ ...search, page: lastPage > 1 ? lastPage : undefined });
  });

  const requested =
    search.from && search.to ? { from: search.from, to: search.to } : undefined;
  const range = logs.isPlaceholderData
    ? (requested ?? logs.data?.range)
    : (logs.data?.range ?? requested);
  const summary = filterSummary(
    search,
    admins.data,
    tenants.data?.items,
    range,
  );
  const setFilter = (patch: Omit<AuditLogSearch, 'page'>) =>
    update({ ...search, ...patch, page: undefined });

  function toggle(id: string) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <AppShell
      identity={identity}
      title="操作日志"
      crumb="操作日志"
      activeNav="操作日志"
    >
      <PageBody title="操作日志" meta="只读 · 记录不可修改或删除">
        <Filters
          search={search}
          range={range}
          admins={admins.data}
          adminCapped={admins.data?.capped ?? false}
          tenants={tenants.data?.items}
          tenantCapped={tenants.data?.capped ?? false}
          rowCount={logs.isPlaceholderData ? undefined : rowCount}
          onRange={(next) => setFilter({ from: next.from, to: next.to })}
          onFilter={setFilter}
          onReset={() => update({})}
        />
        <RefreshError title="操作日志刷新失败，列表可能不是最新" query={logs} />
        {logs.data ? (
          logs.data.items.length === 0 ? (
            <Empty summary={summary} onClear={() => update({})} />
          ) : (
            <Rows
              items={logs.data.items}
              page={page}
              rowCount={logs.data.pagination.total}
              busy={logs.isPlaceholderData}
              openIds={openIds}
              onToggle={toggle}
              onPage={(next) =>
                update({ ...search, page: next > 1 ? next : undefined })
              }
            />
          )
        ) : logs.isError ? (
          <QueryError
            title="操作日志加载失败"
            error={logs.error}
            retrying={logs.isFetching}
            onRetry={() => void logs.refetch()}
          />
        ) : (
          <Skeleton
            aria-busy
            aria-label="操作日志加载中"
            className="h-[240px] rounded-xl"
          />
        )}
      </PageBody>
    </AppShell>
  );
}

function Filters({
  search,
  range,
  admins,
  adminCapped,
  tenants,
  tenantCapped,
  rowCount,
  onRange,
  onFilter,
  onReset,
}: {
  search: AuditLogSearch;
  range: DayRange | undefined;
  admins: Map<string, string> | undefined;
  adminCapped: boolean;
  tenants: readonly DirectoryTenant[] | undefined;
  tenantCapped: boolean;
  rowCount: number | undefined;
  onRange: (range: DayRange) => void;
  onFilter: (patch: Omit<AuditLogSearch, 'page'>) => void;
  onReset: () => void;
}) {
  const activeCount = [search.adminId, search.label, search.tenantId].filter(
    Boolean,
  ).length;
  const selects = (className: string) => (
    <>
      <NamedSelect
        label="管理员"
        className={className}
        value={search.adminId ?? ''}
        {...(adminCapped ? { hint: directoryCapHint } : {})}
        onChange={(value) =>
          onFilter({ adminId: value === '' ? undefined : value })
        }
      >
        <NativeSelectOption value="">全部管理员</NativeSelectOption>
        {search.adminId && !admins?.has(search.adminId) ? (
          <NativeSelectOption value={search.adminId}>
            {admins ? '已选管理员' : '…'}
          </NativeSelectOption>
        ) : null}
        {admins
          ? [...admins].map(([id, name]) => (
              <NativeSelectOption key={id} value={id}>
                {name}
              </NativeSelectOption>
            ))
          : null}
      </NamedSelect>
      <NamedSelect
        label="操作类型"
        className={className}
        value={search.label ?? ''}
        onChange={(value) =>
          onFilter({ label: auditLabelSchema.safeParse(value).data })
        }
      >
        <NativeSelectOption value="">全部操作</NativeSelectOption>
        {auditLabelSchema.options.map((label) => (
          <NativeSelectOption key={label} value={label}>
            {auditLabelText[label]}
          </NativeSelectOption>
        ))}
      </NamedSelect>
      <NamedSelect
        label="租户"
        className={className}
        value={search.tenantId ?? ''}
        {...(tenantCapped ? { hint: directoryCapHint } : {})}
        onChange={(value) =>
          onFilter({ tenantId: value === '' ? undefined : value })
        }
      >
        <NativeSelectOption value="">全部租户</NativeSelectOption>
        {search.tenantId &&
        !tenants?.some((tenant) => tenant.id === search.tenantId) ? (
          <NativeSelectOption value={search.tenantId}>
            {tenants ? '已选租户' : '…'}
          </NativeSelectOption>
        ) : null}
        {tenants?.map((tenant) => (
          <NativeSelectOption key={tenant.id} value={tenant.id}>
            {tenant.code} {tenant.name}
          </NativeSelectOption>
        ))}
      </NamedSelect>
    </>
  );
  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:w-[240px] md:flex-none">
        <span className="hidden text-xs text-muted-foreground md:block">
          日期范围
        </span>
        {range ? (
          <DateRangeField
            label="日期范围"
            value={range}
            max={
              range.to > formatDate(new Date())
                ? range.to
                : formatDate(new Date())
            }
            onChange={onRange}
            className="w-full md:w-[240px]"
          />
        ) : (
          <Button
            variant="outline"
            disabled
            aria-label="日期范围"
            className="h-11 w-full justify-start font-normal text-muted-foreground md:h-9 md:w-[240px]"
          >
            …
          </Button>
        )}
      </div>
      <FilterSheet
        activeCount={activeCount}
        resultLabel={resultLabel(rowCount, '条')}
        onClear={() =>
          onFilter({
            adminId: undefined,
            label: undefined,
            tenantId: undefined,
          })
        }
      >
        {selects('w-full')}
      </FilterSheet>
      <div className="hidden items-end gap-3 md:flex">
        {selects('w-[160px]')}
      </div>
      <Button
        variant="ghost"
        onClick={onReset}
        className="h-11 px-1 font-normal text-muted-foreground hover:bg-transparent md:h-9"
      >
        重置
      </Button>
      {rowCount !== undefined ? (
        <span className="text-[13px] text-muted-foreground tabular-nums md:ml-auto">
          {countLabel(search.page ?? 1, rowCount)}
        </span>
      ) : null}
    </div>
  );
}

function NamedSelect({
  label,
  value,
  onChange,
  className,
  hint,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  className: string;
  hint?: string;
  children: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <NativeSelect
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        containerClassName={className}
        {...(hintId ? { 'aria-describedby': hintId } : {})}
      >
        {children}
      </NativeSelect>
      {hint ? (
        <p id={hintId} className="m-0 text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Empty({ summary, onClear }: { summary: string; onClear: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-16 text-center">
      <span
        aria-hidden
        className="flex size-11 items-center justify-center rounded-full bg-muted text-lg text-muted-foreground"
      >
        ⌕
      </span>
      <span className="text-[15px] font-semibold">没有符合条件的操作记录</span>
      <span className="text-[13px] text-muted-foreground">{summary}</span>
      <Button variant="outline" className="mt-1" onClick={onClear}>
        清除筛选
      </Button>
    </div>
  );
}

function Rows({
  items,
  page,
  rowCount,
  busy,
  openIds,
  onToggle,
  onPage,
}: {
  items: readonly AdminAuditLog[];
  page: number;
  rowCount: number;
  busy: boolean;
  openIds: OpenIds;
  onToggle: (id: string) => void;
  onPage: (page: number) => void;
}) {
  return (
    <div
      aria-busy={busy}
      className={cn('flex flex-col gap-3', busy && 'opacity-60')}
    >
      <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
        <table
          aria-label="操作记录"
          className="w-full border-collapse text-[13px]"
        >
          <thead>
            <tr className="bg-muted text-xs text-muted-foreground">
              <th className="w-8">
                <span className="sr-only">展开</span>
              </th>
              <th className="px-3 py-2.5 text-left font-medium">时间</th>
              <th className="px-3 py-2.5 text-left font-medium">管理员</th>
              <th className="px-3 py-2.5 text-left font-medium">操作</th>
              <th className="px-3 py-2.5 text-left font-medium">对象</th>
              <th className="px-4 py-2.5 text-left font-medium">详情</th>
            </tr>
          </thead>
          <tbody className="tabular-nums">
            {items.map((row) => {
              const open = openIds.has(row.id);
              return (
                <LogRows
                  key={row.id}
                  row={row}
                  open={open}
                  onToggle={() => onToggle(row.id)}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-2.5 md:hidden">
        {items.map((row) => (
          <LogCard
            key={row.id}
            row={row}
            open={openIds.has(row.id)}
            onToggle={() => onToggle(row.id)}
          />
        ))}
      </div>
      <Pagination
        page={page}
        pageSize={pageSize}
        rowCount={rowCount}
        onPage={onPage}
      />
    </div>
  );
}

function LogRows({
  row,
  open,
  onToggle,
}: {
  row: AdminAuditLog;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onToggle();
        }}
        className={cn(
          'cursor-pointer border-t border-border hover:bg-row-hover',
          open && 'bg-brand-soft',
        )}
      >
        <td className="py-3 pl-4 text-[11px] text-muted-foreground">
          {open ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </td>
        <td className="py-3 pr-3 whitespace-nowrap">
          <DateTime value={row.occurredAt} />
        </td>
        <td className="px-3 py-3 whitespace-nowrap">{actorText(row.actor)}</td>
        <td className="px-3 py-3 whitespace-nowrap">
          <OpBadge row={row} />
        </td>
        <td className="px-3 py-3 font-mono whitespace-nowrap">
          {objectText(row)}
        </td>
        <td className="px-4 py-3">{row.summary}</td>
      </tr>
      {open ? (
        <tr className="bg-brand-soft">
          <td />
          <td colSpan={5} className="pr-4 pb-4">
            <Detail row={row} layout="table" />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function LogCard({
  row,
  open,
  onToggle,
}: {
  row: AdminAuditLog;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(
        'flex flex-col gap-1.5 rounded-[10px] border p-3 text-left tabular-nums',
        open ? 'border-primary' : 'border-border',
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <OpBadge row={row} />
          <span className="truncate font-mono text-sm">{objectText(row)}</span>
        </span>
        <span className="text-xs text-muted-foreground">
          {open ? (
            <ChevronDownIcon aria-hidden className="size-3.5" />
          ) : (
            <ChevronRightIcon aria-hidden className="size-3.5" />
          )}
        </span>
      </span>
      <span className="text-sm leading-normal">{row.summary}</span>
      <span className="text-xs text-muted-foreground">
        {actorText(row.actor)} · <DateTime value={row.occurredAt} />
      </span>
      {open ? <Detail row={row} layout="stack" /> : null}
    </button>
  );
}

function OpBadge({ row }: { row: AdminAuditLog }) {
  return (
    <Badge
      variant={toneVariant[toneOf(row.action)]}
      className="h-5 text-[11px] md:h-[22px] md:text-xs"
    >
      {auditLabelText[row.label]}
    </Badge>
  );
}

function Detail({
  row,
  layout,
}: {
  row: AdminAuditLog;
  layout: 'table' | 'stack';
}) {
  const meta = `操作人 ${actorText(row.actor)} · ${formatDateTime(row.occurredAt)} · 只读记录`;
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-2 md:border-t-0 md:pt-0">
      {row.changes.length === 0 ? null : layout === 'table' ? (
        <table
          aria-label="修改前后"
          className="w-full max-w-[760px] border-collapse overflow-hidden rounded-lg border border-border bg-card text-[13px]"
        >
          <thead>
            <tr className="bg-muted text-xs text-muted-foreground">
              <th className="w-[140px] px-3 py-2 text-left font-medium">
                字段
              </th>
              <th className="px-3 py-2 text-left font-medium">修改前</th>
              <th className="px-3 py-2 text-left font-medium">修改后</th>
            </tr>
          </thead>
          <tbody>
            {row.changes.map((change, index) => {
              const before = changeText(change.before);
              return (
                <tr
                  key={`${change.field}-${index}`}
                  className="border-t border-border"
                >
                  <td className="px-3 py-2 text-muted-foreground">
                    {changeFieldText[change.field]}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-muted-foreground',
                      before !== '—' && 'line-through',
                    )}
                  >
                    {before}
                  </td>
                  <td className="px-3 py-2 font-medium">
                    {changeText(change.after)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <div className="flex flex-col gap-1.5">
          {row.changes.map((change, index) => {
            const before = changeText(change.before);
            return (
              <div
                key={`${change.field}-${index}`}
                className="flex flex-col gap-0.5 text-[13px]"
              >
                <span className="text-xs text-muted-foreground">
                  {changeFieldText[change.field]}
                </span>
                <span>
                  <span
                    className={cn(
                      'text-muted-foreground',
                      before !== '—' && 'line-through',
                    )}
                  >
                    {before}
                  </span>
                  {' → '}
                  <span className="font-medium">
                    {changeText(change.after)}
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="m-0 text-xs text-muted-foreground">{meta}</p>
    </div>
  );
}
