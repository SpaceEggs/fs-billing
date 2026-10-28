import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  useQueries,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  AdminCdrDeleteResponse,
  AdminCdrDeletionMonth,
  AdminTenantDetailResponse,
} from '@fs-billing/shared';
import { invalidateTenant, apiQuery, send } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import { formatCount } from '../cdr/cdr-format';
import { formatDate, formatMoney } from '../../lib/format';
import { shiftStatementMonth } from '../../lib/admin-statements';
import { statementMonthTitle } from '../../lib/statement';
import { cn } from '../../lib/utils';
import { QueryError } from '../query-error';
import { MonthGrid, type MonthCellState } from '../month-field';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { invalidClass } from './form-fields';
import { ProblemAlert } from './problem-alert';

/**
 * 删除话单（设计稿删除话单原型、pages.md 3.6.1）。
 * 月份格按月份可选规则置灰。决定 15：当月、无账单月、已删除月不可选。
 * 决定 34：原始 JSON 不随这次删除清除。
 */

/** 与服务端一次删除的上限相同。契约里没有这个数，超过就不逐月请求。 */
const maxDeleteMonths = 120;

const blockedLabel = {
  reconcile_not_ok: '账单待重新生成',
  uncharged_calls: '有话单尚未扣费',
} as const satisfies Record<
  AdminCdrDeletionMonth['blockedReasons'][number],
  string
>;

type OpenGrid = { which: 'from' | 'to'; year: number };

type CdrDeleteFlow =
  | { step: 'pick'; grid: OpenGrid | null }
  | {
      step: 'confirm';
      from: string;
      to: string;
      code: string;
      grid: OpenGrid | null;
      submit: 'idle' | 'pending' | { error: unknown };
    }
  | {
      step: 'done';
      from: string;
      to: string;
      result: AdminCdrDeleteResponse;
      retry: 'idle' | 'pending';
    };

type RangeVerdict =
  | { status: 'incomplete' }
  | { status: 'loading' }
  | { status: 'too-long' }
  | { status: 'blocked'; month: string; reason: string }
  | { status: 'ready'; count: number; months: AdminCdrDeletionMonth[] };

type Tenant = Pick<
  AdminTenantDetailResponse,
  'id' | 'code' | 'name' | 'createdAt' | 'balance' | 'currency'
>;

function monthIndex(month: string) {
  return Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7));
}

function monthSpan(from: string, to: string) {
  return monthIndex(to) - monthIndex(from) + 1;
}

function eachMonth(from: string, to: string) {
  return Array.from({ length: monthSpan(from, to) }, (_, index) =>
    shiftStatementMonth(from, index),
  );
}

function rangeTitle(from: string, to: string) {
  const start = statementMonthTitle(from);
  return from === to ? start : `${start} 至 ${statementMonthTitle(to)}`;
}

function lastDay(month: string) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

/** 展示用。起点是月初与租户创建日 00:00 里较晚的那天，终点是结束月的月末。 */
function displayWindow(fromMonth: string, toMonth: string, createdAt: string) {
  const startDay = `${fromMonth}-01`;
  const endDay = `${toMonth}-${String(lastDay(toMonth)).padStart(2, '0')}`;
  const createdDay = formatDate(createdAt);
  const start =
    createdDay > startDay && createdDay <= endDay ? createdDay : startDay;
  return { start, end: endDay };
}

function blockedSub(reasons: AdminCdrDeletionMonth['blockedReasons']) {
  return (['reconcile_not_ok', 'uncharged_calls'] as const)
    .flatMap((reason) =>
      reasons.includes(reason) ? [blockedLabel[reason]] : [],
    )
    .join('、');
}

function monthCell(row: AdminCdrDeletionMonth | undefined): MonthCellState {
  if (!row) return { disabled: true };
  switch (row.state) {
    case 'deletable':
      return row.cdrCount === null
        ? { disabled: true, title: '不可选' }
        : { disabled: false, sub: `${formatCount(row.cdrCount)} 条` };
    case 'deleted':
      return { disabled: true, sub: '已删除', title: '该月话单已删除' };
    case 'no_statement':
      return {
        disabled: true,
        sub: '账单未生成',
        title: '本月账单尚未生成，不可选',
      };
    case 'before_opening':
      return { disabled: true, sub: '未开户' };
    case 'future':
      return { disabled: true, sub: '尚未到达' };
    case 'blocked':
      return {
        disabled: true,
        sub: blockedSub(row.blockedReasons) || '不可选',
      };
  }
}

function blockReason(row: AdminCdrDeletionMonth) {
  const cell = monthCell(row);
  return cell.title ?? cell.sub ?? '不可选';
}

function rangeVerdict(
  from: string,
  to: string,
  byMonth: ReadonlyMap<string, AdminCdrDeletionMonth>,
): RangeVerdict {
  if (from > to) return { status: 'incomplete' };
  if (monthSpan(from, to) > maxDeleteMonths) return { status: 'too-long' };
  const months: AdminCdrDeletionMonth[] = [];
  let count = 0;
  for (const month of eachMonth(from, to)) {
    const row = byMonth.get(month);
    if (!row) return { status: 'loading' };
    if (row.state !== 'deletable' || row.cdrCount === null)
      return { status: 'blocked', month, reason: blockReason(row) };
    months.push(row);
    count += row.cdrCount;
  }
  return { status: 'ready', count, months };
}

function codeHint(code: string, tenantCode: string) {
  if (code.length === 0) return '区分大小写';
  if (code === tenantCode) return '✓ 编码正确';
  if (tenantCode.startsWith(code)) return '继续输入…';
  return `编码不一致，请输入 ${tenantCode}`;
}

function collectYears(flow: CdrDeleteFlow, currentYear: number) {
  const found = new Set<number>([currentYear]);
  if (flow.step !== 'done' && flow.grid) found.add(flow.grid.year);
  const ranges: Array<[string, string]> = [];
  if (flow.step !== 'pick') ranges.push([flow.from, flow.to]);
  if (flow.step === 'done' && flow.result.remaining.length > 0) {
    const first = flow.result.remaining[0];
    const last = flow.result.remaining[flow.result.remaining.length - 1];
    if (first && last) ranges.push([first, last]);
  }
  for (const [from, to] of ranges) {
    if (from > to || monthSpan(from, to) > maxDeleteMonths) continue;
    const start = Number(from.slice(0, 4));
    const end = Number(to.slice(0, 4));
    for (let year = start; year <= end; year += 1) found.add(year);
  }
  return [...found].sort((left, right) => left - right);
}

function invalidateDeletionMonths(queryClient: QueryClient, tenantId: string) {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => {
      if (
        queryKey[0] !== 'api' ||
        queryKey[1] !== 'adminTenantCdrDeletionMonths'
      )
        return false;
      const input = queryKey[2] as { params?: { tenantId?: string } };
      return input.params?.tenantId === tenantId;
    },
  });
}

export function CdrDeleteDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: Tenant;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [locked, setLocked] = useState(false);
  if (!open && locked) setLocked(false);
  return (
    <ModalDialog
      open={open}
      {...(locked ? {} : { onOpenChange })}
      title="删除话单"
      className="md:w-[560px]"
    >
      {open ? (
        <CdrDeleteForm
          tenant={tenant}
          onClose={() => onOpenChange(false)}
          onLockedChange={setLocked}
        />
      ) : null}
    </ModalDialog>
  );
}

function CdrDeleteForm({
  tenant,
  onClose,
  onLockedChange,
}: {
  tenant: Tenant;
  onClose: () => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [flow, setFlow] = useState<CdrDeleteFlow>({ step: 'pick', grid: null });
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const currentYear = Number(formatDate(new Date()).slice(0, 4));
  const years = useMemo(
    () => collectYears(flow, currentYear),
    [flow, currentYear],
  );
  const yearQueries = useQueries({
    queries: years.map((year) =>
      apiQuery('adminTenantCdrDeletionMonths', {
        params: { tenantId: tenant.id },
        query: { year },
      }),
    ),
  });
  const byMonth = new Map<string, AdminCdrDeletionMonth>();
  const queryByYear = new Map(
    years.map((year, index) => [year, yearQueries[index]] as const),
  );
  for (const query of yearQueries)
    for (const row of query.data?.months ?? []) byMonth.set(row.month, row);
  const verdict =
    flow.step === 'pick'
      ? ({ status: 'incomplete' } as const)
      : rangeVerdict(flow.from, flow.to, byMonth);
  const fetching = yearQueries.some((query) => query.isFetching);
  const pending =
    (flow.step === 'confirm' && flow.submit === 'pending') ||
    (flow.step === 'done' && flow.retry === 'pending');
  const code = flow.step === 'confirm' ? flow.code : '';
  const codeMatches = code === tenant.code;
  const canSubmit =
    flow.step === 'confirm' &&
    flow.submit !== 'pending' &&
    codeMatches &&
    verdict.status === 'ready' &&
    !fetching;

  async function submitRange(from: string, to: string, expectedCount: number) {
    if (busy.current || flow.step === 'pick') return;
    busy.current = true;
    onLockedChange(true);
    const confirmedCode = flow.step === 'confirm' ? flow.code : tenant.code;
    setFlow((current) => {
      if (current.step === 'confirm')
        return { ...current, submit: 'pending', grid: null };
      if (current.step === 'done') return { ...current, retry: 'pending' };
      return current;
    });
    try {
      const result = await send('adminTenantCdrDelete', {
        params: { tenantId: tenant.id },
        body: {
          fromMonth: from,
          toMonth: to,
          tenantCode: tenant.code,
          expectedCount,
        },
      });
      try {
        await invalidateTenant(queryClient, tenant.id);
      } catch {
        // 刷新失败不能把已经删掉的月份说成没删。
      }
      if (!mounted.current) return;
      setFlow({ step: 'done', from, to, result, retry: 'idle' });
    } catch (error) {
      if (apiProblem(error).kind === 'conflict') {
        try {
          await invalidateDeletionMonths(queryClient, tenant.id);
        } catch {
          // 冲突说明仍然要留下，月份格刷新失败不盖住它。
        }
      }
      if (!mounted.current) return;
      setFlow({
        step: 'confirm',
        from,
        to,
        code: confirmedCode,
        grid: null,
        submit: { error },
      });
    } finally {
      busy.current = false;
      onLockedChange(false);
    }
  }

  function openPicker(which: 'from' | 'to') {
    setFlow((current) => {
      if (current.step === 'done') return current;
      if (current.step === 'confirm' && current.submit === 'pending')
        return current;
      const selected =
        current.step === 'confirm'
          ? which === 'from'
            ? current.from
            : current.to
          : null;
      const year = selected ? Number(selected.slice(0, 4)) : currentYear;
      const grid = current.grid?.which === which ? null : { which, year };
      return { ...current, grid };
    });
  }

  function onPick(month: string) {
    setFlow((current) => {
      if (current.step === 'done' || !current.grid) return current;
      if (current.step === 'confirm' && current.submit === 'pending')
        return current;
      if (current.step === 'pick')
        return {
          step: 'confirm',
          from: month,
          to: month,
          code: '',
          grid: null,
          submit: 'idle',
        };
      const from = current.grid.which === 'from' ? month : current.from;
      const to = current.grid.which === 'to' ? month : current.to;
      // 开始晚于结束时收成刚选的那一个月，避免提交服务端会拒绝的倒序。
      const ordered = from <= to ? { from, to } : { from: month, to: month };
      return { ...current, ...ordered, grid: null, submit: 'idle' };
    });
  }

  if (flow.step === 'done')
    return (
      <DoneView
        tenant={tenant}
        flow={flow}
        byMonth={byMonth}
        onClose={onClose}
        onRetry={(from, to, expectedCount) =>
          void submitRange(from, to, expectedCount)
        }
      />
    );

  const grid = flow.grid;
  const gridQuery = grid ? queryByYear.get(grid.year) : undefined;
  const selected =
    grid && flow.step === 'confirm'
      ? grid.which === 'from'
        ? flow.from
        : flow.to
      : null;
  const failedQuery = yearQueries.find((query) => query.isError && !query.data);
  const monthsPending = yearQueries.some((query) => query.isPending);
  const submitError = flow.step === 'confirm' ? flow.submit : 'idle';

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit || verdict.status !== 'ready') return;
        void submitRange(flow.from, flow.to, verdict.count);
      }}
    >
      <div className="flex flex-col gap-1 pr-8">
        <h2 className="m-0 text-[17px] font-semibold">删除话单</h2>
        <p className="m-0 text-[13px] text-muted-foreground">
          <span className="font-mono">{tenant.code}</span> {tenant.name} ·
          按整月删除
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {(['from', 'to'] as const).map((which) => {
          const label = which === 'from' ? '开始月份' : '结束月份';
          const value = flow.step === 'confirm' ? flow[which] : null;
          const text = value ? statementMonthTitle(value) : '选择月份';
          const opened = grid?.which === which;
          return (
            <div
              key={which}
              className="flex flex-col gap-1.5 text-[13px] font-medium"
            >
              <span>{label}</span>
              <button
                type="button"
                aria-label={`${label}：${text}`}
                aria-expanded={opened}
                disabled={pending}
                onClick={() => openPicker(which)}
                className={cn(
                  'flex h-11 items-center justify-between rounded-lg border px-3 text-sm font-normal outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50 md:h-10',
                  opened ? 'border-primary' : 'border-input',
                )}
              >
                <span className={value ? undefined : 'text-muted-foreground'}>
                  {text}
                </span>
                <span aria-hidden className="text-xs text-muted-foreground">
                  ▾
                </span>
              </button>
            </div>
          );
        })}
      </div>
      {grid ? (
        <div className="rounded-[10px] border border-border p-3">
          {gridQuery?.isPending ? (
            <p role="status" className="m-0 text-sm text-muted-foreground">
              正在加载可删除的月份…
            </p>
          ) : gridQuery?.isError && !gridQuery.data ? (
            <QueryError
              title="可删除月份加载失败"
              error={gridQuery.error}
              retrying={gridQuery.isFetching}
              onRetry={() => void gridQuery.refetch()}
            />
          ) : (
            <MonthGrid
              year={grid.year}
              minYear={1}
              maxYear={currentYear}
              onYearChange={(year) =>
                setFlow((current) =>
                  current.step === 'done' || !current.grid
                    ? current
                    : { ...current, grid: { ...current.grid, year } },
                )
              }
              value={selected}
              onPick={onPick}
              cell={(month) => monthCell(byMonth.get(month))}
            />
          )}
        </div>
      ) : null}
      <Preview
        tenant={tenant}
        flow={flow}
        verdict={verdict}
        failedQuery={failedQuery}
        monthsPending={monthsPending}
      />
      {/* 决定 34：原文按归档策略老化，这次删除不碰它。 */}
      <div className="flex gap-2.5 rounded-[10px] border border-err-border bg-err-soft px-3.5 py-3 text-[13px] leading-relaxed text-err">
        <span
          aria-hidden
          className="flex size-5 shrink-0 items-center justify-center rounded-full bg-destructive text-xs font-bold text-white"
        >
          !
        </span>
        <p className="m-0">
          <span className="font-semibold">删除后无法恢复。</span>
          余额和已生成的月账单不受影响，但该时段将无法导出话单明细，也无法重新生成月账单。
          原始 JSON 不随删除话单清除，按归档策略老化。
        </p>
      </div>
      <CodeField
        tenantCode={tenant.code}
        code={code}
        disabled={flow.step !== 'confirm' || pending}
        onChange={(value) =>
          setFlow((current) =>
            current.step === 'confirm' && current.submit !== 'pending'
              ? { ...current, code: value.trim() }
              : current,
          )
        }
      />
      {typeof submitError === 'object' ? (
        <ProblemAlert
          error={submitError.error}
          networkMessage="无法确认删除是否完成，请关闭对话框后查看话单。"
          onRefresh={() =>
            void invalidateDeletionMonths(queryClient, tenant.id)
          }
        />
      ) : null}
      <div className="flex flex-col-reverse gap-2 border-t border-border pt-3.5 md:flex-row md:justify-end">
        <Button
          type="button"
          variant="outline"
          className="h-12 md:h-9"
          disabled={pending}
          onClick={onClose}
        >
          取消
        </Button>
        <Button
          type="submit"
          className="h-12 bg-destructive text-white md:h-9"
          disabled={!canSubmit}
        >
          {verdict.status === 'ready'
            ? `删除 ${formatCount(verdict.count)} 条话单`
            : '删除'}
        </Button>
      </div>
    </form>
  );
}

function Preview({
  tenant,
  flow,
  verdict,
  failedQuery,
  monthsPending,
}: {
  tenant: Tenant;
  flow: Exclude<CdrDeleteFlow, { step: 'done' }>;
  verdict: RangeVerdict;
  failedQuery:
    | {
        error: unknown;
        isFetching: boolean;
        refetch: () => unknown;
      }
    | undefined;
  monthsPending: boolean;
}) {
  if (verdict.status === 'ready' && flow.step === 'confirm') {
    const shown = displayWindow(flow.from, flow.to, tenant.createdAt);
    return (
      <div className="flex flex-col gap-1 rounded-[10px] border border-border bg-muted px-4 py-3.5 tabular-nums">
        <p className="m-0 text-[15px]">
          将删除 <span className="font-mono font-semibold">{tenant.code}</span>{' '}
          在{' '}
          <span className="font-semibold">
            {rangeTitle(flow.from, flow.to)}
          </span>{' '}
          的{' '}
          <span className="font-semibold text-neg">
            {formatCount(verdict.count)}
          </span>{' '}
          条话单
        </p>
        <p className="m-0 text-xs text-muted-foreground">
          时间范围 {shown.start} 00:00:00 至 {shown.end} 23:59:59（北京时间）
        </p>
      </div>
    );
  }
  if (verdict.status === 'blocked')
    return (
      <p className="m-0 rounded-[10px] border border-dashed border-input px-4 py-3.5 text-[13px] text-muted-foreground">
        {statementMonthTitle(verdict.month)}不可选：{verdict.reason}
      </p>
    );
  if (verdict.status === 'too-long')
    return (
      <p className="m-0 rounded-[10px] border border-dashed border-input px-4 py-3.5 text-[13px] text-muted-foreground">
        一次最多删除 {maxDeleteMonths} 个月
      </p>
    );
  if (failedQuery)
    return (
      <QueryError
        title="可删除月份加载失败"
        error={failedQuery.error}
        retrying={failedQuery.isFetching}
        onRetry={() => void failedQuery.refetch()}
      />
    );
  if (monthsPending || verdict.status === 'loading')
    return (
      <p role="status" className="m-0 text-sm text-muted-foreground">
        正在加载可删除的月份…
      </p>
    );
  return (
    <p className="m-0 rounded-[10px] border border-dashed border-input px-4 py-3.5 text-[13px] text-muted-foreground">
      请选择开始和结束月份，选择后显示将删除的话单数量
    </p>
  );
}

function CodeField({
  tenantCode,
  code,
  disabled,
  onChange,
}: {
  tenantCode: string;
  code: string;
  disabled: boolean;
  onChange: (code: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const hint = codeHint(code, tenantCode);
  const hardWrong = code.length > 0 && !tenantCode.startsWith(code);
  return (
    <div className="flex flex-col gap-1.5 text-[13px] font-medium">
      <label htmlFor={id}>
        请输入租户编码{' '}
        <span className="rounded bg-muted px-1.5 py-px font-mono font-normal">
          {tenantCode}
        </span>{' '}
        以确认
      </label>
      <Input
        id={id}
        value={code}
        disabled={disabled}
        placeholder={`输入 ${tenantCode}`}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-describedby={hintId}
        aria-invalid={hardWrong ? true : undefined}
        className={cn(
          'font-mono',
          invalidClass(hardWrong ? hint : undefined),
          code === tenantCode ? 'border-ok-border' : undefined,
        )}
        onChange={(event) => onChange(event.target.value)}
      />
      <span
        id={hintId}
        className={cn(
          'text-xs font-normal',
          hardWrong
            ? 'text-neg'
            : code === tenantCode
              ? 'text-ok'
              : 'text-muted-foreground',
        )}
      >
        {hint}
      </span>
    </div>
  );
}

function DoneView({
  tenant,
  flow,
  byMonth,
  onClose,
  onRetry,
}: {
  tenant: Tenant;
  flow: Extract<CdrDeleteFlow, { step: 'done' }>;
  byMonth: ReadonlyMap<string, AdminCdrDeletionMonth>;
  onClose: () => void;
  onRetry: (from: string, to: string, expectedCount: number) => void;
}) {
  const { result } = flow;
  if (result.failure) {
    const first = result.remaining[0];
    const last = result.remaining[result.remaining.length - 1];
    const retry =
      first && last
        ? rangeVerdict(first, last, byMonth)
        : { status: 'incomplete' as const };
    const retrying = flow.retry === 'pending';
    return (
      <div className="flex flex-col gap-4">
        <div role="alert" className="flex flex-col gap-2 text-sm">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {result.months.map((row) => (
              <li key={row.month}>
                {statementMonthTitle(row.month)} 已删除{' '}
                {formatCount(row.deleted)} 条
              </li>
            ))}
          </ul>
          <p className="m-0">
            尚未删除：
            {result.remaining
              .map((month) => statementMonthTitle(month))
              .join('、')}
          </p>
          <p className="m-0 font-semibold text-err">{result.failure.message}</p>
        </div>
        {retry.status === 'blocked' ? (
          <p className="m-0 text-sm text-muted-foreground">
            {statementMonthTitle(retry.month)}不可选：{retry.reason}
          </p>
        ) : retry.status === 'loading' ? (
          <p role="status" className="m-0 text-sm text-muted-foreground">
            正在加载可删除的月份…
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={retrying}
            onClick={onClose}
          >
            完成
          </Button>
          <Button
            className="h-12 md:h-9"
            disabled={retrying || retry.status !== 'ready' || !first || !last}
            onClick={() => {
              if (retry.status !== 'ready' || !first || !last) return;
              onRetry(first, last, retry.count);
            }}
          >
            重试剩余月份
          </Button>
        </div>
      </div>
    );
  }
  const shown = displayWindow(flow.from, flow.to, tenant.createdAt);
  const span = rangeTitle(flow.from, flow.to);
  return (
    <div className="flex flex-col items-center gap-3 pt-4 text-center">
      <span
        aria-hidden
        className="flex size-12 items-center justify-center rounded-full border border-ok-border bg-ok-soft text-[22px] font-bold text-ok"
      >
        ✓
      </span>
      <h2 className="m-0 text-[17px] font-semibold">
        已删除 {formatCount(result.total)} 条话单
      </h2>
      <p className="m-0 text-sm text-muted-foreground tabular-nums">
        {tenant.code} · {span}（{shown.start} 至 {shown.end}）
      </p>
      <p
        role="status"
        className="m-0 text-[13px] leading-relaxed text-muted-foreground"
      >
        已自动记入操作日志。余额{' '}
        {formatMoney({ currency: tenant.currency, amount: tenant.balance })} 和{' '}
        {span} 月账单不受影响。
      </p>
      <Button className="mt-2 h-12 w-full md:h-10" onClick={onClose}>
        完成
      </Button>
    </div>
  );
}
