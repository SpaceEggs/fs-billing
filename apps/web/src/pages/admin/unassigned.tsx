import { useEffect, useState } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type {
  AdminUnassignedGroup,
  AdminUnassignedRow,
  Identity,
  UnassignedSelection,
} from '@fs-billing/shared';
import { Tabs, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Checkbox } from '../../components/ui/checkbox';
import { Alert } from '../../components/ui/alert';
import { UnassignedAssignDialog } from '../../components/admin/unassigned-assign-dialog';
import { UnassignedIgnoreDialog } from '../../components/admin/unassigned-ignore-dialog';
import { RequestFailure } from '../../components/admin/problem-alert';
import { AppShell, PageBody } from '../../components/app-shell';
import { DateTime } from '../../components/data-format';
import { Pagination } from '../../components/pagination';
import { QueryError, RefreshError } from '../../components/query-error';
import { Button } from '../../components/ui/button';
import {
  apiKey,
  apiQuery,
  invalidateUnassigned,
  send,
  useApiMutation,
} from '../../lib/admin-api';
import type { ApiQuery } from '../../lib/api';
import type { UnassignedSearch } from '../../lib/admin-search';
import { formatDateTime } from '../../lib/format';
import { formatDuration } from '../../lib/duration';
import { cn } from '../../lib/utils';

const pageSize = 50;

type Selection =
  | { kind: 'none' }
  | { kind: 'ids'; ids: ReadonlySet<string> }
  | { kind: 'group'; tag: string };

type OpenPanel =
  | {
      kind: 'assign';
      selection: UnassignedSelection;
      label: string;
      tagLabel: string | null;
      suggested: AdminUnassignedGroup['suggestedTenants'];
    }
  | {
      kind: 'ignore';
      selection: UnassignedSelection;
      count: number;
      subtitle: string;
    };

type PageNotice =
  | null
  | { kind: 'ignored'; count: number }
  | { kind: 'unignored'; count: number };

type Listed = {
  status: 'pending' | 'ignored' | 'superseded';
  items: AdminUnassignedRow[];
  pagination: { page: number; pageSize: number; total: number };
  requestedTag: string | null;
};

function countText(value: number) {
  return value.toLocaleString('en-US');
}

function tagTitle(tag: string) {
  return tag === '' ? '标签为空' : `标签 ${tag}`;
}

function tagLabel(tag: string) {
  return tag === '' ? '（空）' : tag;
}

function groupSubtitle(group: AdminUnassignedGroup) {
  if (group.suggestedTenants.length > 0)
    return `疑似拼写错误，相近：${group.suggestedTenants.map((tenant) => tenant.code).join('、')}`;
  return group.tag === '' ? '话单未携带租户标签' : '找不到对应租户';
}

function toApiSelection(
  selection: Exclude<Selection, { kind: 'none' }>,
): UnassignedSelection | null {
  if (selection.kind === 'group') return { group: { tag: selection.tag } };
  const ids = [...selection.ids];
  return ids.length > 0 ? { ids } : null;
}

function keptSearch(search: UnassignedSearch, page?: number): UnassignedSearch {
  return {
    ...(search.tab ? { tab: search.tab } : {}),
    ...(search.tag !== undefined ? { tag: search.tag } : {}),
    ...(page !== undefined && page > 1 ? { page } : {}),
  };
}

function useUnassignedSearch() {
  const search = useSearch({ from: '/admin/unassigned' });
  const navigate = useNavigate({ from: '/admin/unassigned' });
  const update = (next: UnassignedSearch) =>
    void navigate({ search: next, replace: true });
  return { search, update };
}

/** 未归属话单（pages.md §3.9）：待处理按标签分组，归属后补扣费，或填写原因后忽略。 */
export function AdminUnassignedPage({ identity }: { identity: Identity }) {
  const { search, update } = useUnassignedSearch();
  const queryClient = useQueryClient();
  const unignoreMutation = useApiMutation('adminUnassignedUnignore');
  const tab: 'pending' | 'ignored' =
    search.tab === 'ignored' ? 'ignored' : 'pending';
  const page = search.page ?? 1;
  const summary = useQuery(apiQuery('adminUnassignedSummary'));
  const showList =
    summary.isSuccess && (tab === 'ignored' || summary.data.pending > 0);
  const groups = useQuery({
    ...apiQuery('adminUnassignedGroups'),
    enabled: showList && tab === 'pending',
  });
  const listQuery = {
    status: tab,
    page,
    pageSize,
    ...(search.tag !== undefined ? { tag: search.tag } : {}),
  } satisfies ApiQuery<'adminUnassignedList'>;
  const list = useQuery({
    queryKey: apiKey('adminUnassignedList', { query: listQuery }),
    queryFn: async (): Promise<Listed> => ({
      ...(await send('adminUnassignedList', { query: listQuery })),
      requestedTag: search.tag ?? null,
    }),
    placeholderData: keepPreviousData,
    enabled: showList,
  });
  const listed =
    list.data?.status === tab && list.data.requestedTag === (search.tag ?? null)
      ? list.data
      : undefined;
  const filterKey = `${tab}\0${search.tag ?? '\u0001'}`;
  const [seenFilter, setSeenFilter] = useState(filterKey);
  const [selection, setSelection] = useState<Selection>({ kind: 'none' });
  const [panel, setPanel] = useState<OpenPanel | null>(null);
  const [notice, setNotice] = useState<PageNotice>(null);
  const [unignoring, setUnignoring] = useState<string | null>(null);
  const [unignoreError, setUnignoreError] = useState<unknown>(null);
  if (seenFilter !== filterKey) {
    setSeenFilter(filterKey);
    setSelection({ kind: 'none' });
  }

  const lastPage = Math.max(
    1,
    Math.ceil((listed?.pagination.total ?? 0) / pageSize),
  );
  const pastLastPage =
    listed !== undefined &&
    !list.isPlaceholderData &&
    listed.items.length === 0 &&
    page > lastPage;
  useEffect(() => {
    if (pastLastPage) update(keptSearch(search, lastPage));
  });

  const activeGroup =
    search.tag === undefined
      ? undefined
      : groups.data?.groups.find((group) => group.tag === search.tag);
  const contextTitle = search.tag === undefined ? '全部' : tagTitle(search.tag);
  const selectedCount =
    selection.kind === 'group'
      ? (listed?.pagination.total ?? 0)
      : selection.kind === 'ids'
        ? selection.ids.size
        : 0;
  const canSelectGroup =
    search.tag !== undefined &&
    selection.kind !== 'group' &&
    listed !== undefined &&
    listed.pagination.total > listed.items.length;
  const selectGroupLabel =
    search.tag !== undefined && listed
      ? `选择「${tagTitle(search.tag)}」全部 ${countText(listed.pagination.total)} 条`
      : '';

  function togglePage(rows: readonly AdminUnassignedRow[]) {
    setSelection((current) => {
      if (current.kind === 'group') return { kind: 'none' };
      const ids = new Set(current.kind === 'ids' ? current.ids : []);
      const all = rows.length > 0 && rows.every((row) => ids.has(row.id));
      if (all) for (const row of rows) ids.delete(row.id);
      else for (const row of rows) ids.add(row.id);
      return ids.size === 0 ? { kind: 'none' } : { kind: 'ids', ids };
    });
  }

  function toggleRow(id: string) {
    setSelection((current) => {
      if (current.kind === 'group') return current;
      const ids = new Set(current.kind === 'ids' ? current.ids : []);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return ids.size === 0 ? { kind: 'none' } : { kind: 'ids', ids };
    });
  }

  function openAssign() {
    if (selection.kind === 'none') return;
    const api = toApiSelection(selection);
    if (!api) return;
    setPanel({
      kind: 'assign',
      selection: api,
      label: `已选 ${countText(selectedCount)} 条 · ${contextTitle}`,
      tagLabel: search.tag === undefined ? null : tagTitle(search.tag),
      suggested: activeGroup?.suggestedTenants ?? [],
    });
  }

  function openIgnore() {
    if (selection.kind === 'none') return;
    const api = toApiSelection(selection);
    if (!api) return;
    setPanel({
      kind: 'ignore',
      selection: api,
      count: selectedCount,
      subtitle: `已选 ${countText(selectedCount)} 条 · ${contextTitle}`,
    });
  }

  async function unignore(id: string) {
    setUnignoring(id);
    setUnignoreError(null);
    try {
      const result = await unignoreMutation.mutateAsync({
        body: { selection: { ids: [id] } },
      });
      await invalidateUnassigned(queryClient);
      setNotice({ kind: 'unignored', count: result.changed });
    } catch (error) {
      setUnignoreError(error);
    } finally {
      setUnignoring(null);
    }
  }

  const pendingEmpty = summary.data?.pending === 0 && tab === 'pending';

  return (
    <AppShell
      identity={identity}
      title="未归属话单"
      crumb="未归属话单"
      activeNav="未归属话单"
    >
      <PageBody title="未归属话单">
        <p className="m-0 text-[13px] text-muted-foreground">
          话单中的租户标签缺失，或找不到对应租户。这些话单尚未计费，可归属到租户后补扣费，或填写原因后忽略。
        </p>
        {summary.isError && !summary.data ? (
          <QueryError
            title="未归属话单加载失败"
            error={summary.error}
            retrying={summary.isFetching}
            onRetry={() => void summary.refetch()}
          />
        ) : null}
        <RefreshError
          title="未归属话单刷新失败，数据可能不是最新"
          query={summary}
        />
        {summary.data ? (
          <Tabs
            value={tab}
            onValueChange={(next) =>
              update(next === 'ignored' ? { tab: 'ignored' } : {})
            }
            className="gap-0"
          >
            <TabsList aria-label="未归属话单">
              <TabButton
                value="pending"
                selected={tab === 'pending'}
                count={summary.data.pending}
              >
                待处理
              </TabButton>
              <TabButton
                value="ignored"
                selected={tab === 'ignored'}
                count={summary.data.ignored}
              >
                已忽略
              </TabButton>
            </TabsList>
          </Tabs>
        ) : summary.isPending ? (
          <p aria-busy="true" className="m-0 text-sm text-muted-foreground">
            加载中
          </p>
        ) : null}
        <PageStatus notice={notice} onDismiss={() => setNotice(null)} />
        {pendingEmpty ? <PendingEmpty /> : null}
        {tab === 'pending' && summary.data && summary.data.pending > 0 ? (
          <>
            <Alert variant="warning" className="m-0 px-3.5 text-foreground">
              <span className="font-semibold text-warn">提示</span> 请同时检查
              FreeSWITCH 中的 <code className="font-mono">billing_tenant</code>{' '}
              配置，否则新话单会继续进入此处。
            </Alert>
            {groups.isError && !groups.data ? (
              <QueryError
                title="分组加载失败"
                error={groups.error}
                retrying={groups.isFetching}
                onRetry={() => void groups.refetch()}
              />
            ) : groups.data ? (
              <GroupCards
                total={groups.data.total}
                groupCount={groups.data.groups.length}
                groups={groups.data.groups}
                tag={search.tag}
                onSelect={(tag) => update(tag === undefined ? {} : { tag })}
              />
            ) : (
              <p aria-busy="true" className="m-0 text-sm text-muted-foreground">
                加载中
              </p>
            )}
            {selection.kind === 'none' ? (
              <div className="flex flex-wrap items-center gap-3 text-[13px] text-muted-foreground">
                <span>
                  勾选话单，或点击上方分组后「选择该分组全部」，再归属到租户或忽略。
                </span>
                {canSelectGroup ? (
                  <button
                    type="button"
                    className="text-primary underline"
                    onClick={() =>
                      search.tag !== undefined &&
                      setSelection({ kind: 'group', tag: search.tag })
                    }
                  >
                    {selectGroupLabel}
                  </button>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-brand-border bg-brand-soft px-4 py-2 text-sm">
                <span className="font-semibold tabular-nums">
                  {selection.kind === 'group'
                    ? `已选择「${contextTitle}」全部 ${countText(selectedCount)} 条`
                    : `已选 ${countText(selectedCount)} 条`}
                </span>
                {canSelectGroup ? (
                  <button
                    type="button"
                    className="text-[13px] text-primary underline"
                    onClick={() =>
                      search.tag !== undefined &&
                      setSelection({ kind: 'group', tag: search.tag })
                    }
                  >
                    {selectGroupLabel}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-[13px] text-muted-foreground underline"
                  onClick={() => setSelection({ kind: 'none' })}
                >
                  清除选择
                </button>
                <span className="hidden flex-1 md:block" />
                <Button variant="outline" size="sm" onClick={openIgnore}>
                  忽略
                </Button>
                <Button size="sm" onClick={openAssign}>
                  归属到租户
                </Button>
              </div>
            )}
          </>
        ) : null}
        {showList && !listed && list.isError ? (
          <QueryError
            title="话单加载失败"
            error={list.error}
            retrying={list.isFetching}
            onRetry={() => void list.refetch()}
          />
        ) : null}
        <RefreshError title="话单刷新失败，数据可能不是最新" query={list} />
        {unignoreError ? <RequestFailure error={unignoreError} /> : null}
        {listed && tab === 'pending' ? (
          <PendingRows
            rows={listed.items}
            total={listed.pagination.total}
            page={page}
            selection={selection}
            busy={list.isFetching}
            onTogglePage={() => togglePage(listed.items)}
            onToggleRow={toggleRow}
            onPage={(next) => update(keptSearch(search, next))}
          />
        ) : null}
        {listed && tab === 'ignored' ? (
          <IgnoredRows
            rows={listed.items}
            total={listed.pagination.total}
            page={page}
            busy={list.isFetching}
            unignoring={unignoring}
            onUnignore={(id) => void unignore(id)}
            onPage={(next) => update(keptSearch(search, next))}
          />
        ) : null}
        {showList && !listed && !list.isError ? (
          <p aria-busy="true" className="m-0 text-sm text-muted-foreground">
            加载中
          </p>
        ) : null}
      </PageBody>
      {panel?.kind === 'assign' ? (
        <UnassignedAssignDialog
          open
          selection={panel.selection}
          selectionLabel={panel.label}
          tagLabel={panel.tagLabel}
          suggested={panel.suggested}
          onOpenChange={(open) => {
            if (!open) setPanel(null);
          }}
          onAssigned={() => setSelection({ kind: 'none' })}
        />
      ) : null}
      {panel?.kind === 'ignore' ? (
        <UnassignedIgnoreDialog
          open
          selection={panel.selection}
          count={panel.count}
          subtitle={panel.subtitle}
          onOpenChange={(open) => {
            if (!open) setPanel(null);
          }}
          onIgnored={(changed) => {
            setNotice({ kind: 'ignored', count: changed });
            setSelection({ kind: 'none' });
            setPanel(null);
          }}
        />
      ) : null}
    </AppShell>
  );
}

function TabButton({
  value,
  selected,
  count,
  children,
}: {
  value: 'pending' | 'ignored';
  selected: boolean;
  count: number;
  children: string;
}) {
  return (
    <TabsTrigger value={value}>
      {children}
      <span
        className={cn(
          'rounded-full px-1.5 text-xs font-medium tabular-nums',
          selected
            ? 'max-md:bg-primary-foreground/15 md:bg-muted md:text-muted-foreground'
            : 'bg-muted',
        )}
      >
        {countText(count)}
      </span>
    </TabsTrigger>
  );
}

function PageStatus({
  notice,
  onDismiss,
}: {
  notice: PageNotice;
  onDismiss: () => void;
}) {
  if (!notice) return null;
  const text =
    notice.kind === 'ignored'
      ? notice.count > 0
        ? `已忽略 ${countText(notice.count)} 条，可在「已忽略」中撤销`
        : '这些话单已不在待处理'
      : notice.count > 0
        ? '已撤销忽略，话单回到「待处理」'
        : '这些话单已不在已忽略';
  const quiet =
    (notice.kind === 'ignored' || notice.kind === 'unignored') &&
    notice.count === 0;
  return (
    <Alert
      variant={quiet ? 'muted' : 'success'}
      role="status"
      className={cn(
        'flex-row items-start justify-between gap-3 px-3.5',
        quiet && 'text-muted-foreground',
      )}
    >
      <span>{text}</span>
      <Button
        variant="link"
        className="h-auto shrink-0 p-0 text-[13px] font-normal text-current"
        onClick={onDismiss}
      >
        知道了
      </Button>
    </Alert>
  );
}

function PendingEmpty() {
  return (
    <div className="flex flex-col items-center gap-2.5 rounded-xl border border-border px-5 py-16 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-xl text-ok"
      >
        ✓
      </span>
      <span className="text-[17px] font-semibold">所有话单都已归属</span>
      <span className="text-[13px] text-muted-foreground">
        没有待处理的未归属话单
      </span>
    </div>
  );
}

function GroupCards({
  total,
  groupCount,
  groups,
  tag,
  onSelect,
}: {
  total: number;
  groupCount: number;
  groups: readonly AdminUnassignedGroup[];
  tag: string | undefined;
  onSelect: (tag: string | undefined) => void;
}) {
  return (
    <div className="flex flex-col gap-2 md:grid md:grid-cols-3">
      <GroupCard
        title="全部"
        subtitle={`${countText(groupCount)} 个分组`}
        count={total}
        selected={tag === undefined}
        warn={false}
        onClick={() => onSelect(undefined)}
      />
      {groups.map((group) => (
        <GroupCard
          key={`tag:${group.tag}`}
          title={tagTitle(group.tag)}
          subtitle={groupSubtitle(group)}
          detail={group.reasons
            .map((reason) => `${reason.reason} ${countText(reason.count)}`)
            .join(' · ')}
          count={group.count}
          selected={tag === group.tag}
          warn={group.suggestedTenants.length > 0}
          onClick={() => onSelect(group.tag)}
        />
      ))}
    </div>
  );
}

function GroupCard({
  title,
  subtitle,
  detail,
  count,
  selected,
  warn,
  onClick,
}: {
  title: string;
  subtitle: string;
  detail?: string;
  count: number;
  selected: boolean;
  warn: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-[10px] border px-3.5 py-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
        selected
          ? 'border-primary bg-brand-soft ring-1 ring-primary'
          : 'border-border',
      )}
    >
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <span className="text-lg font-semibold tabular-nums">
          {countText(count)}
          <span className="text-xs font-normal text-muted-foreground"> 条</span>
        </span>
      </span>
      <span
        className={cn('text-xs', warn ? 'text-warn' : 'text-muted-foreground')}
      >
        {subtitle}
      </span>
      {detail ? (
        <span className="text-xs text-muted-foreground">{detail}</span>
      ) : null}
    </button>
  );
}

function pageInfo(page: number, rowCount: number) {
  if (rowCount === 0) return '共 0 条';
  if (rowCount <= pageSize) return `共 ${countText(rowCount)} 条`;
  const start = (page - 1) * pageSize + 1;
  const last = page * pageSize;
  const end = last < rowCount ? last : rowCount;
  return `第 ${countText(start)}–${countText(end)} 条，共 ${countText(rowCount)} 条`;
}

function momentOf(row: AdminUnassignedRow) {
  return row.time ?? row.receivedAt;
}

function PendingRows({
  rows,
  total,
  page,
  selection,
  busy,
  onTogglePage,
  onToggleRow,
  onPage,
}: {
  rows: readonly AdminUnassignedRow[];
  total: number;
  page: number;
  selection: Selection;
  busy: boolean;
  onTogglePage: () => void;
  onToggleRow: (id: string) => void;
  onPage: (page: number) => void;
}) {
  const picked = (id: string) =>
    selection.kind === 'group' ||
    (selection.kind === 'ids' && selection.ids.has(id));
  const selectedOnPage = rows.filter((row) => picked(row.id)).length;
  const allOnPage = rows.length > 0 && selectedOnPage === rows.length;
  return (
    <div aria-busy={busy} className="flex flex-col gap-3">
      {total === 0 ? (
        <p className="m-0 rounded-xl border border-border px-5 py-10 text-center text-sm text-muted-foreground">
          没有待处理的话单
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
            <table className="w-full border-collapse text-[13px] whitespace-nowrap">
              <thead>
                <tr className="bg-muted text-xs text-muted-foreground">
                  <th className="w-11 py-2.5 pr-0 pl-4 text-left font-medium">
                    <Checkbox
                      aria-label="选择本页"
                      checked={
                        selection.kind === 'group' || allOnPage
                          ? true
                          : selectedOnPage > 0
                            ? 'indeterminate'
                            : false
                      }
                      onCheckedChange={onTogglePage}
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    接通时间
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    话单中的租户标签
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    主叫号码
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    被叫号码
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    通话时长
                  </th>
                  {/* 决定 9：原因单独一列；决定 35：不可分配的行标出来。 */}
                  <th className="px-4 py-2.5 text-left font-medium">原因</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2.5 pr-0 pl-4">
                      <Checkbox
                        aria-label={`选择 ${row.caller} 呼 ${row.callee}`}
                        checked={picked(row.id)}
                        disabled={selection.kind === 'group'}
                        onCheckedChange={() => onToggleRow(row.id)}
                      />
                    </td>
                    <td className="px-3 py-2.5">
                      <CallTime row={row} />
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2.5',
                        row.tag ? 'font-mono' : 'text-muted-foreground',
                      )}
                    >
                      {tagLabel(row.tag)}
                    </td>
                    <td className="px-3 py-2.5">{row.caller}</td>
                    <td className="px-3 py-2.5">{row.callee}</td>
                    <td className="px-3 py-2.5 text-right">
                      {formatDuration(row.durationSeconds)}
                    </td>
                    <td className="px-4 py-2.5 whitespace-normal">
                      {row.reason}
                      {row.assignable ? '' : ' · 不可分配'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => (
              <article
                key={row.id}
                aria-label={`${row.callee}，主叫 ${row.caller}`}
                className="flex items-center gap-1 rounded-[10px] border border-border py-3 pr-3.5 pl-1"
              >
                <label className="flex size-11 shrink-0 items-center justify-center">
                  <Checkbox
                    aria-label={`选择 ${row.caller} 呼 ${row.callee}`}
                    checked={picked(row.id)}
                    disabled={selection.kind === 'group'}
                    onCheckedChange={() => onToggleRow(row.id)}
                    className="size-5"
                  />
                </label>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="flex justify-between gap-2">
                    <span className="font-medium">{row.callee}</span>
                    <span className="tabular-nums">
                      {formatDuration(row.durationSeconds)}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(momentOf(row)).slice(5)} · 主叫 {row.caller}{' '}
                    · <span className="font-mono">{tagLabel(row.tag)}</span>
                    {row.time ? '' : ' · 接收时间'}
                    {row.assignable ? '' : ' · 不可分配'}
                  </span>
                  <span className="text-xs">{row.reason}</span>
                </div>
              </article>
            ))}
          </div>
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {pageInfo(page, total)}
          </span>
          <Pagination
            page={page}
            pageSize={pageSize}
            rowCount={total}
            onPage={onPage}
          />
        </>
      )}
    </div>
  );
}

function CallTime({ row }: { row: AdminUnassignedRow }) {
  if (row.time) return <DateTime value={row.time} />;
  return (
    <span>
      <DateTime value={row.receivedAt} />
      <span className="text-muted-foreground"> 接收时间</span>
    </span>
  );
}

function IgnoredRows({
  rows,
  total,
  page,
  busy,
  unignoring,
  onUnignore,
  onPage,
}: {
  rows: readonly AdminUnassignedRow[];
  total: number;
  page: number;
  busy: boolean;
  unignoring: string | null;
  onUnignore: (id: string) => void;
  onPage: (page: number) => void;
}) {
  return (
    <div aria-busy={busy} className="flex flex-col gap-3">
      {total === 0 ? (
        <p className="m-0 rounded-xl border border-border px-5 py-12 text-center text-sm text-muted-foreground">
          没有已忽略的话单
        </p>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-[10px] border border-border md:block">
            <table className="w-full border-collapse text-[13px] whitespace-nowrap">
              <thead>
                <tr className="bg-muted text-xs text-muted-foreground">
                  <th className="px-4 py-2.5 text-left font-medium">
                    接通时间
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    租户标签
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    主叫号码
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    被叫号码
                  </th>
                  <th className="px-3 py-2.5 text-right font-medium">
                    通话时长
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    忽略原因
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium">
                    操作人 · 时间
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {rows.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="px-4 py-2.5">
                      <CallTime row={row} />
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2.5',
                        row.tag ? 'font-mono' : 'text-muted-foreground',
                      )}
                    >
                      {tagLabel(row.tag)}
                    </td>
                    <td className="px-3 py-2.5">{row.caller}</td>
                    <td className="px-3 py-2.5">{row.callee}</td>
                    <td className="px-3 py-2.5 text-right">
                      {formatDuration(row.durationSeconds)}
                    </td>
                    <td className="max-w-[280px] px-3 py-2.5 whitespace-normal">
                      {row.ignore?.reason ?? '—'}
                    </td>
                    <td className="px-3 py-2.5 text-muted-foreground">
                      {operatorText(row)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <UnignoreButton
                        row={row}
                        pending={unignoring === row.id}
                        onUnignore={onUnignore}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-col gap-2 md:hidden">
            {rows.map((row) => (
              <article
                key={row.id}
                aria-label={`${row.callee}，主叫 ${row.caller}`}
                className="flex flex-col gap-2 rounded-[10px] border border-border p-3.5"
              >
                <span className="flex justify-between gap-2">
                  <span className="font-medium">{row.callee}</span>
                  <span className="tabular-nums">
                    {formatDuration(row.durationSeconds)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {formatDateTime(momentOf(row)).slice(5)} · 主叫 {row.caller} ·{' '}
                  <span className="font-mono">{tagLabel(row.tag)}</span>
                  {row.time ? '' : ' · 接收时间'}
                </span>
                <span className="text-[13px]">{row.ignore?.reason ?? '—'}</span>
                <span className="text-xs text-muted-foreground">
                  {operatorText(row)}
                </span>
                <UnignoreButton
                  row={row}
                  pending={unignoring === row.id}
                  onUnignore={onUnignore}
                />
              </article>
            ))}
          </div>
          <span className="text-[13px] text-muted-foreground tabular-nums">
            {pageInfo(page, total)}
          </span>
          <p className="m-0 text-xs text-muted-foreground">
            撤销后话单回到「待处理」，可重新归属或忽略。忽略和撤销均记入操作日志。
          </p>
          <Pagination
            page={page}
            pageSize={pageSize}
            rowCount={total}
            onPage={onPage}
          />
        </>
      )}
    </div>
  );
}

function operatorText(row: AdminUnassignedRow) {
  const who = row.ignore?.by?.name ?? '—';
  return row.ignore?.at ? `${who} · ${formatDateTime(row.ignore.at)}` : who;
}

function UnignoreButton({
  row,
  pending,
  onUnignore,
}: {
  row: AdminUnassignedRow;
  pending: boolean;
  onUnignore: (id: string) => void;
}) {
  return (
    <button
      type="button"
      className="text-[13px] text-primary underline disabled:opacity-50"
      disabled={pending}
      onClick={() => onUnignore(row.id)}
    >
      {pending ? '正在撤销…' : '撤销忽略'}
    </button>
  );
}
