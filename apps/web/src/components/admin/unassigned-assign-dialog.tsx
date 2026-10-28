import { useDeferredValue, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  AdminUnassignedAssignResponse,
  AdminUnassignedGroup,
  AdminUnassignedPreviewResponse,
  UnassignedSelection,
} from '@fs-billing/shared';
import { Input } from '../ui/input';
import { Alert } from '../ui/alert';
import {
  apiQuery,
  invalidateTenant,
  invalidateUnassigned,
  useApiMutation,
} from '../../lib/admin-api';
import { ApiRequestError } from '../../lib/api';
import { apiProblem, problemNotice } from '../../lib/api-problem';
import { formatDate, formatDateTime, formatMoney } from '../../lib/format';
import { statementMonthTitle } from '../../lib/statement';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ProblemAlert, RequestFailure } from './problem-alert';

const tenantPageSize = 100;

type SuggestedTenant = AdminUnassignedGroup['suggestedTenants'][number];
type NoRateGroup = AdminUnassignedPreviewResponse['noRate']['groups'][number];
type StatementState =
  AdminUnassignedPreviewResponse['affectedMonths'][number]['statementState'];

/** 决定 6：只有已出账的月份需要重新生成；当前月和未生成的月份点进去会碰到 STATEMENT_NOT_FINAL。 */
const statementStateText = {
  final: '已出账，需重新生成',
  live: '当前月，账单尚未生成',
  none: '账单尚未生成',
} as const satisfies Record<StatementState, string>;

type PreviewLoad =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; error: unknown }
  | { status: 'ready'; data: AdminUnassignedPreviewResponse };

type AssignFlow =
  | {
      step: 'form';
      tenantId: string | null;
      preview: PreviewLoad;
      /** 409 之后保留说明，同时用同一次打开的幂等键重新预览。 */
      stale: string | null;
      submit: 'idle' | 'submitting' | { error: unknown };
    }
  | {
      step: 'done';
      result: AdminUnassignedAssignResponse;
      tenantCode: string;
    };

/**
 * 确认被明确拒绝，原因是选择或批次已过时（没有可分配的话单、幂等键对应别的内容、
 * 对象不存在）。这时重复确认没有意义，要先刷新。预览过期由重新预览单独处理，网络中断不在此列。
 */
function isStaleRejection(error: unknown) {
  if (error instanceof ApiRequestError && error.outcomeUnknown) return false;
  const problem = apiProblem(error);
  return (
    (problem.kind === 'conflict' || problem.kind === 'not-found') &&
    problemNotice(problem).refresh
  );
}

function minutePrecision(value: string) {
  const text = formatDateTime(value);
  return text.endsWith(':00') ? text.slice(0, -3) : text;
}

/** 决定 36：无费率留在待处理，文案按接通时刻计价，不用设计稿的「请先在费率表补充该前缀」。 */
function noRateExplanation(group: NoRateGroup, tenantCode: string) {
  const sample = group.samples[0];
  const when = sample ? `接通时（${formatDate(sample.answeredAt)}）` : '接通时';
  const head =
    group.reason === 'before_first_version'
      ? `${when}${tenantCode} 还没有生效的费率${
          group.firstEffectiveFrom
            ? `，第一个费率版本自 ${minutePrecision(group.firstEffectiveFrom)} 起生效`
            : ''
        }。`
      : `${when}${tenantCode} 的费率表里没有匹配的前缀${
          group.prefixHint
            ? `（最接近：${group.prefixHint.prefix} ${group.prefixHint.country}）`
            : ''
        }。`;
  return `${head}费率按接通时刻计价，不能回溯，这 ${group.count} 条不能分配，会留在待处理；可以忽略并填写原因，需要补收的费用请用『调账』在当前月补记。`;
}

function money(currency: 'CNY' | 'USD', amount: string) {
  return formatMoney({ currency, amount });
}

export function UnassignedAssignDialog({
  open,
  selection,
  selectionLabel,
  tagLabel,
  suggested,
  onOpenChange,
  onAssigned,
}: {
  open: boolean;
  selection: UnassignedSelection;
  /** 例如「已选 326 条 · 标签 ABC01」。 */
  selectionLabel: string;
  /** 当前分组标题；相近租户的提示用它。全部时为空。 */
  tagLabel: string | null;
  suggested: readonly SuggestedTenant[];
  onOpenChange: (open: boolean) => void;
  /** 成功后清掉页面上的勾选；对话框留在结果页。 */
  onAssigned: () => void;
}) {
  const [locked, setLocked] = useState(false);
  return (
    <ModalDialog
      open={open}
      {...(locked ? {} : { onOpenChange })}
      title="归属到租户"
      description={selectionLabel}
      className="md:w-[560px]"
    >
      {open ? (
        <AssignFlow
          selection={selection}
          selectionLabel={selectionLabel}
          tagLabel={tagLabel}
          suggested={suggested}
          onOpenChange={onOpenChange}
          onAssigned={onAssigned}
          onLockedChange={setLocked}
        />
      ) : null}
    </ModalDialog>
  );
}

function AssignFlow({
  selection,
  selectionLabel,
  tagLabel,
  suggested,
  onOpenChange,
  onAssigned,
  onLockedChange,
}: {
  selection: UnassignedSelection;
  selectionLabel: string;
  tagLabel: string | null;
  suggested: readonly SuggestedTenant[];
  onOpenChange: (open: boolean) => void;
  onAssigned: () => void;
  onLockedChange: (locked: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const previewMutation = useApiMutation('adminUnassignedAssignPreview');
  const assignMutation = useApiMutation('adminUnassignedAssign');
  // 同一次打开复用同一键，包括网络重试和预览过期后的再次确认。
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => `web:${crypto.randomUUID()}`,
  );
  const ticket = useRef(0);
  const [flow, setFlow] = useState<AssignFlow>({
    step: 'form',
    tenantId: null,
    preview: { status: 'idle' },
    stale: null,
    submit: 'idle',
  });
  const submitting = flow.step === 'form' && flow.submit === 'submitting';

  function loadPreview(tenantId: string, stale: string | null) {
    const request = (ticket.current += 1);
    setFlow({
      step: 'form',
      tenantId,
      preview: { status: 'loading' },
      stale,
      submit: 'idle',
    });
    void previewMutation
      .mutateAsync({
        body: { tenantId, selection },
      })
      .then(
        (data) => {
          if (request !== ticket.current) return;
          setFlow({
            step: 'form',
            tenantId,
            preview: { status: 'ready', data },
            stale,
            submit: 'idle',
          });
        },
        (error: unknown) => {
          if (request !== ticket.current) return;
          setFlow({
            step: 'form',
            tenantId,
            preview: { status: 'error', error },
            stale,
            submit: 'idle',
          });
        },
      );
  }

  async function confirm() {
    if (flow.step !== 'form' || flow.preview.status !== 'ready') return;
    if (flow.submit === 'submitting' || flow.preview.data.assignable === 0)
      return;
    if (typeof flow.submit === 'object' && isStaleRejection(flow.submit.error))
      return;
    const preview = flow.preview.data;
    setFlow({ ...flow, submit: 'submitting' });
    onLockedChange(true);
    try {
      const result = await assignMutation.mutateAsync({
        body: {
          tenantId: preview.tenant.id,
          selection,
          idempotencyKey,
          expected: {
            assignable: preview.assignable,
            noRate: preview.noRate.count,
            chargeTotal: preview.chargeTotal,
          },
        },
      });
      onAssigned();
      setFlow({ step: 'done', result, tenantCode: preview.tenant.code });
      // 归属已经完成，刷新不阻塞结果页，失败也不影响它。
      void invalidateUnassigned(queryClient).catch(() => {});
      void invalidateTenant(queryClient, result.tenantId).catch(() => {});
    } catch (error) {
      const problem = apiProblem(error);
      if (
        problem.kind === 'conflict' &&
        problem.code === 'UNASSIGNED_PREVIEW_STALE'
      ) {
        loadPreview(preview.tenant.id, problem.message);
        return;
      }
      if (isStaleRejection(error))
        void invalidateUnassigned(queryClient).catch(() => {});
      setFlow({ ...flow, submit: { error } });
    } finally {
      onLockedChange(false);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-1 pr-8">
        <h2 className="m-0 text-[17px] font-semibold">
          {flow.step === 'done' ? '归属完成' : '归属到租户'}
        </h2>
        <p className="m-0 text-[13px] text-muted-foreground">
          {selectionLabel}
        </p>
      </div>
      {flow.step === 'done' ? (
        <AssignResult
          result={flow.result}
          tenantCode={flow.tenantCode}
          onClose={() => onOpenChange(false)}
        />
      ) : (
        <AssignForm
          flow={flow}
          tagLabel={tagLabel}
          suggested={suggested}
          submitting={submitting}
          onPick={(tenantId) => loadPreview(tenantId, null)}
          onConfirm={() => void confirm()}
          onRefresh={() => {
            if (!flow.tenantId) return;
            // 幂等键对应的是别的内容时，同一个键再提交只会再次冲突；
            // 这是被明确拒绝的请求，没有写入，换新键安全。
            if (typeof flow.submit === 'object') {
              const problem = apiProblem(flow.submit.error);
              if (
                problem.kind === 'conflict' &&
                problem.code === 'IDEMPOTENCY_CONFLICT'
              )
                setIdempotencyKey(`web:${crypto.randomUUID()}`);
            }
            void invalidateUnassigned(queryClient).catch(() => {});
            loadPreview(flow.tenantId, null);
          }}
          onClose={() => onOpenChange(false)}
        />
      )}
    </>
  );
}

function AssignForm({
  flow,
  tagLabel,
  suggested,
  submitting,
  onPick,
  onConfirm,
  onRefresh,
  onClose,
}: {
  flow: Extract<AssignFlow, { step: 'form' }>;
  tagLabel: string | null;
  suggested: readonly SuggestedTenant[];
  submitting: boolean;
  onPick: (tenantId: string) => void;
  onConfirm: () => void;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const preview = flow.preview.status === 'ready' ? flow.preview.data : null;
  const staleRejection =
    typeof flow.submit === 'object' && isStaleRejection(flow.submit.error);
  const confirmLabel = preview
    ? `确认归属 ${preview.assignable} 条并扣费`
    : '确认归属';
  return (
    <>
      <TenantPicker
        tagLabel={tagLabel}
        suggested={suggested}
        tenantId={flow.tenantId}
        disabled={submitting}
        onPick={onPick}
      />
      {flow.stale ? (
        <p role="status" className="m-0 text-[13px] text-warn">
          {flow.stale}
        </p>
      ) : null}
      {flow.preview.status === 'loading' ? (
        <p aria-busy="true" className="m-0 text-[13px] text-muted-foreground">
          正在预览…
        </p>
      ) : null}
      {flow.preview.status === 'error' ? (
        <RequestFailure error={flow.preview.error} />
      ) : null}
      {preview ? <PreviewFigures preview={preview} /> : null}
      {flow.submit !== 'idle' && flow.submit !== 'submitting' ? (
        <RequestFailure
          error={flow.submit.error}
          networkMessage="网络中断，归属可能已经完成。请先刷新核对，再用这个对话框重试。"
          {...(staleRejection ? { onRefresh } : {})}
        />
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={submitting}
          onClick={onClose}
        >
          取消
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={
            submitting ||
            staleRejection ||
            preview === null ||
            preview.assignable === 0
          }
          onClick={onConfirm}
        >
          {submitting ? '正在归属…' : confirmLabel}
        </Button>
      </div>
    </>
  );
}

function PreviewFigures({
  preview,
}: {
  preview: AdminUnassignedPreviewResponse;
}) {
  const currency = preview.currency;
  const charge = money(currency, preview.chargeTotal);
  const noRate = preview.noRate.count > 0;
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 overflow-hidden rounded-[10px] border border-border tabular-nums md:grid-cols-3">
        <Figure
          label="实际归属"
          value={`${preview.assignable} 条`}
          hint={`已选 ${preview.selected} 条`}
        />
        <Figure
          label="扣费合计"
          value={charge}
          hint={`按 ${preview.tenant.code} 费率计算`}
        />
        <Figure
          label="匹配不到费率"
          value={`${preview.noRate.count} 条`}
          hint={noRate ? '不能归属' : ''}
          warn={noRate}
        />
      </div>
      {preview.noRate.groups.map((group, index) => (
        <Alert
          key={`${group.reason}-${index}`}
          variant="warning"
          className="m-0 text-foreground"
        >
          {noRateExplanation(group, preview.tenant.code)}
        </Alert>
      ))}
      {preview.blocked.count > 0 ? (
        // 决定 38：接通月份已删除的话单不可分配，留在待处理。
        <p className="m-0 text-[13px] leading-normal text-muted-foreground">
          接通月份已删除，{preview.blocked.count} 条不能分配（
          {preview.blocked.months.map(statementMonthTitle).join('、')}
          ）。这些话单会留在待处理。
        </p>
      ) : null}
      {preview.notAssignable.count > 0 ? (
        <p className="m-0 text-[13px] leading-normal text-muted-foreground">
          另有 {preview.notAssignable.count} 条不能分配：
          {preview.notAssignable.reasons
            .map((reason) => `${reason.reason} ${reason.count}`)
            .join('、')}
          。可以忽略，不会被归属。
        </p>
      ) : null}
      <p className="m-0 text-[13px] leading-normal text-muted-foreground tabular-nums">
        {`确认后从 ${preview.tenant.code} 余额扣除 ${charge}（${money(currency, preview.balance.current)} → ${money(currency, preview.balance.afterEstimate)}），并记入操作日志。`}
      </p>
      {/* 决定 6：确认前就要看到哪些月份会过期。重新生成链接留在结果页。 */}
      <AffectedMonths months={preview.affectedMonths} />
    </div>
  );
}

function Figure({
  label,
  value,
  hint,
  warn = false,
}: {
  label: string;
  value: string;
  hint: string;
  warn?: boolean;
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-b border-border px-3.5 py-3 last:border-b-0 md:border-r md:border-b-0 md:last:border-r-0',
        warn && 'bg-warn-soft text-warn',
      )}
    >
      <span
        className={cn('text-xs', warn ? 'text-warn' : 'text-muted-foreground')}
      >
        {label}
      </span>
      <span className="text-xl font-semibold">{value}</span>
      {hint ? (
        <span
          className={cn(
            'text-[11px]',
            warn ? 'text-warn' : 'text-muted-foreground',
          )}
        >
          {hint}
        </span>
      ) : null}
    </div>
  );
}

function AffectedMonths({
  months,
  tenantId,
}: {
  months: AdminUnassignedPreviewResponse['affectedMonths'];
  /** 结果页才传。已出账的月份链到账单页；预览只列出月份和状态。 */
  tenantId?: string;
}) {
  if (months.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium">受影响的月份</span>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
        {months.map((month) => (
          <li
            key={month.month}
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <span>
              {statementMonthTitle(month.month)} ·{' '}
              {statementStateText[month.statementState]}
            </span>
            {tenantId && month.statementState === 'final' ? (
              <Link
                to="/admin/tenants/$tenantId"
                params={{ tenantId }}
                search={{
                  tab: 'statements',
                  statementMonth: month.month,
                }}
                className="underline"
              >
                前往账单页重新生成
              </Link>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AssignResult({
  result,
  tenantCode,
  onClose,
}: {
  result: AdminUnassignedAssignResponse;
  tenantCode: string;
  onClose: () => void;
}) {
  const currency = result.currency;
  return (
    <>
      <p
        role="status"
        className="m-0 text-sm leading-relaxed text-muted-foreground tabular-nums"
      >
        {`已归属 ${result.assigned} 条到 ${tenantCode}，扣费 ${money(currency, result.chargeTotal)}（${money(currency, result.balanceBefore)} → ${money(currency, result.balanceAfter)}）。`}
        {result.noRate > 0
          ? ` ${result.noRate} 条匹配不到费率，留在待处理。`
          : ''}
        {result.blocked > 0
          ? ` ${result.blocked} 条因接通月份已删除，留在待处理。`
          : ''}
        {result.replayed ? ' 这是此前同一操作的结果，没有再次扣费。' : ''}
      </p>
      <AffectedMonths
        months={result.affectedMonths}
        tenantId={result.tenantId}
      />
      <div className="flex justify-end">
        <Button className="h-12 md:h-9" onClick={onClose}>
          完成
        </Button>
      </div>
    </>
  );
}

function TenantPicker({
  tagLabel,
  suggested,
  tenantId,
  disabled,
  onPick,
}: {
  tagLabel: string | null;
  suggested: readonly SuggestedTenant[];
  tenantId: string | null;
  disabled: boolean;
  onPick: (tenantId: string) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const tenants = useQuery(
    apiQuery('adminTenants', {
      query: {
        page: 1,
        pageSize: tenantPageSize,
        ...(deferred ? { search: deferred } : {}),
      },
    }),
  );
  const suggestedIds = new Set(suggested.map((tenant) => tenant.id));
  const query = deferred.toLowerCase();
  const suggestedShown = suggested.filter(
    (tenant) =>
      !query ||
      tenant.code.toLowerCase().includes(query) ||
      tenant.name.toLowerCase().includes(query),
  );
  const others =
    tenants.data?.items.filter((tenant) => !suggestedIds.has(tenant.id)) ?? [];
  const more =
    tenants.data !== undefined &&
    tenants.data.pagination.total > tenants.data.items.length;
  const hint = tagLabel ? `与${tagLabel} 相近` : '相近租户';
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[13px] font-medium">归属到租户</span>
      <Input
        type="search"
        aria-label="搜索编码或名称"
        placeholder="搜索编码或名称"
        maxLength={200}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        className="h-10 text-sm"
      />
      {suggestedShown.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="相近租户"
          className="flex flex-col rounded-lg border border-border"
        >
          {suggestedShown.map((tenant) => (
            <TenantOption
              key={tenant.id}
              name={id}
              checked={tenant.id === tenantId}
              disabled={disabled}
              code={tenant.code}
              label={tenant.name}
              hint={hint}
              hintTone="warn"
              onPick={() => onPick(tenant.id)}
            />
          ))}
        </div>
      ) : null}
      {tenants.isError ? (
        <ProblemAlert
          error={tenants.error}
          onRefresh={() => void tenants.refetch()}
        />
      ) : !tenants.data ? (
        <div
          aria-busy="true"
          aria-label="租户加载中"
          className="h-10 animate-pulse rounded-lg bg-skeleton"
        />
      ) : others.length > 0 ? (
        <div
          role="radiogroup"
          aria-label="全部租户"
          className="flex max-h-[220px] flex-col overflow-auto rounded-lg border border-border"
        >
          {others.map((tenant) => (
            <TenantOption
              key={tenant.id}
              name={id}
              checked={tenant.id === tenantId}
              disabled={disabled}
              code={tenant.code}
              label={tenant.name}
              hint={tenant.currency}
              hintTone="muted"
              onPick={() => onPick(tenant.id)}
            />
          ))}
        </div>
      ) : suggestedShown.length === 0 ? (
        <span className="rounded-lg border border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
          {deferred ? '没有匹配的租户' : '没有租户'}
        </span>
      ) : null}
      {more ? (
        <span className="text-xs text-muted-foreground">
          只显示前 {tenantPageSize} 个，请搜索编码或名称
        </span>
      ) : null}
    </div>
  );
}

function TenantOption({
  name,
  checked,
  disabled,
  code,
  label,
  hint,
  hintTone,
  onPick,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  code: string;
  label: string;
  hint: string;
  hintTone: 'warn' | 'muted';
  onPick: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0 has-checked:bg-brand-soft has-focus-visible:ring-[3px] has-focus-visible:ring-ring">
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
        className="accent-primary"
      />
      <span className="font-mono">{code}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span
        className={cn(
          'text-xs',
          hintTone === 'warn' ? 'text-warn' : 'text-muted-foreground',
        )}
      >
        {hint}
      </span>
    </label>
  );
}
