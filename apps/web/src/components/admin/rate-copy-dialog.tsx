import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  type AdminRateSchedule,
  type AdminRateVersionResponse,
  type Currency,
} from '@fs-billing/shared';
import {
  apiQuery,
  invalidateTenant,
  useApiMutation,
} from '../../lib/admin-api';
import { apiProblem, fieldIssues } from '../../lib/api-problem';
import { formatDateTime } from '../../lib/format';
import { resolveSchedule, type ScheduleChoice } from '../../lib/rates';
import { cn } from '../../lib/utils';
import { TriangleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button, buttonVariants } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ProblemAlert } from './problem-alert';
import { ScheduleField } from './rate-edit-dialog';
import {
  DialogHeading,
  PreviewChanges,
  StepList,
  tableSizes,
  type PreviewLabels,
  type RatePreview,
} from './rate-preview';

/**
 * push（第二批 §9）：从本租户复制到用户选的目标；pull（§10a 空表）：从用户选的来源复制到本租户。
 * 两个方向的接口路径都是来源租户，body.targetTenantId 是目标。
 */
export type RateCopyDirection = 'push' | 'pull';

export type CopyTenant = {
  id: string;
  code: string;
  name: string;
  currency: Currency;
};

/** 一方租户及其费率版本快照：来源取 current.id 作 sourceVersionId，目标取作 targetBaseVersionId。 */
export type CopySide = {
  tenant: CopyTenant;
  versionId: string;
  entryCount: number;
  hasScheduled: boolean;
};

type Picked =
  | { status: 'loading'; tenant: CopyTenant }
  | { status: 'error'; tenant: CopyTenant; error: unknown }
  | { status: 'ready'; side: CopySide };

type Bound = {
  preview: RatePreview;
  schedule: AdminRateSchedule;
  source: CopySide;
  target: CopySide;
};

/** `uncertain`：确认复制时网络中断或 5xx，不知道是否已复制。 */
export type RateCopyState =
  | { step: 'step1'; notice: string | null; error: unknown }
  | { step: 'previewing' }
  | (Bound & { step: 'step2'; error: unknown; uncertain: boolean })
  | (Bound & { step: 'committing'; uncertain: boolean })
  | (Bound & { step: 'done'; response: AdminRateVersionResponse });

const pickerPageSize = 20;

export const targetScheduledMessage =
  '目标租户已有排定的新版本，请先在目标租户取消排定';

function stepIndex(step: RateCopyState['step']) {
  if (step === 'step1' || step === 'previewing') return 0;
  if (step === 'done') return 2;
  return 1;
}

function summary({ tenant, entryCount }: CopySide) {
  return `${tenant.code} ${tenant.name} · ${tenant.currency} · ${entryCount} 条`;
}

/**
 * 复制费率表（pages.md §3.6；第二批 §9、§10a）：选择租户与生效时间 → 预览目标的变动 → 完成。
 * 版本 ID 在打开、选中时取快照，提交时不读实时数据。预览过期、过时、冲突退回第 1 步，保留所选租户与生效时间。
 * 确认复制不自动重试。
 */
export function RateCopyDialog({
  direction,
  self: initialSelf,
  onClose,
  fallbackFocus,
}: {
  direction: RateCopyDirection;
  self: CopySide;
  onClose: () => void;
  fallbackFocus: React.RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const previewCopy = useApiMutation('adminRateCopyPreview');
  const commitCopy = useApiMutation('adminRateCopyCommit');
  const [self, setSelf] = useState(initialSelf);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'immediate' });
  const [scheduleError, setScheduleError] = useState<string | undefined>();
  const [pickError, setPickError] = useState<string | null>(null);
  const [state, setState] = useState<RateCopyState>({
    step: 'step1',
    notice: null,
    error: null,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const busy = state.step === 'previewing' || state.step === 'committing';
  const push = direction === 'push';

  useEffect(() => {
    if (!busy) headingRef.current?.focus();
  }, [state.step, busy]);

  async function snapshot(tenant: CopyTenant): Promise<CopySide> {
    const rates = await queryClient.fetchQuery({
      ...apiQuery('adminRates', { params: { tenantId: tenant.id }, query: {} }),
      staleTime: 0,
    });
    return {
      tenant,
      versionId: rates.current.id,
      entryCount: rates.current.entries.length,
      hasScheduled: rates.scheduled.length > 0,
    };
  }

  async function pick(tenant: CopyTenant) {
    setPickError(null);
    setState({ step: 'step1', notice: null, error: null });
    setPicked({ status: 'loading', tenant });
    const next: Picked = await snapshot(tenant).then(
      (side) => ({ status: 'ready', side }),
      (error: unknown) => ({ status: 'error', tenant, error }),
    );
    setPicked((current) =>
      current?.status === 'loading' && current.tenant.id === tenant.id
        ? next
        : current,
    );
  }

  const pickedSide = picked?.status === 'ready' ? picked.side : null;
  const source = push ? self : pickedSide;
  const target = push ? pickedSide : self;
  const blocked = target?.hasScheduled ?? false;

  /** 冲突后按刷新到的目标完整表重新取快照，下次预览即与最新版本比较。 */
  async function rebaseTarget(side: CopySide) {
    await invalidateTenant(queryClient, side.tenant.id);
    try {
      const fresh = await snapshot(side.tenant);
      if (push) setPicked({ status: 'ready', side: fresh });
      else setSelf(fresh);
    } catch {
      // 刷新失败时保留原快照，再次预览会重新报冲突。
    }
  }

  async function runPreview() {
    if (!source || !target) {
      setPickError(push ? '请选择目标租户' : '请选择来源租户');
      return;
    }
    const resolved = resolveSchedule(
      choice,
      Date.now(),
      DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
    );
    if ('error' in resolved) {
      setScheduleError(resolved.error);
      return;
    }
    setScheduleError(undefined);
    setState({ step: 'previewing' });
    try {
      const result = await previewCopy.mutateAsync({
        params: { tenantId: source.tenant.id },
        body: {
          sourceVersionId: source.versionId,
          targetTenantId: target.tenant.id,
          targetBaseVersionId: target.versionId,
          schedule: resolved.schedule,
        },
      });
      if (result.ok)
        setState({
          step: 'step2',
          preview: result,
          schedule: resolved.schedule,
          source,
          target,
          error: null,
          uncertain: false,
        });
      else
        setState({
          step: 'step1',
          notice: `无法预览：${result.errors.map((error) => error.reason).join('；')}`,
          error: null,
        });
    } catch (error) {
      const problem = apiProblem(error);
      if (problem.kind === 'conflict') {
        if (problem.code === 'RATE_VERSION_CONFLICT') {
          await rebaseTarget(target);
          setState({
            step: 'step1',
            notice: '目标租户费率表已被修改，已载入最新版本，请重新预览',
            error: null,
          });
          return;
        }
        if (problem.code === 'CURRENCY_MISMATCH') {
          setState({
            step: 'step1',
            notice: '来源与目标租户币种不一致，费率不能跨币种复制',
            error: null,
          });
          return;
        }
      }
      setScheduleError(fieldIssues(problem).get('schedule.effectiveFrom'));
      setState({ step: 'step1', notice: null, error });
    }
  }

  async function runCommit(current: Extract<RateCopyState, { step: 'step2' }>) {
    const { preview, schedule, source, target, uncertain } = current;
    const bound: Bound = { preview, schedule, source, target };
    setState({ ...bound, step: 'committing', uncertain });
    try {
      const response = await commitCopy.mutateAsync({
        params: { tenantId: bound.source.tenant.id },
        body: { previewId: bound.preview.previewId },
      });
      setState({ ...bound, step: 'done', response });
      await Promise.all([
        invalidateTenant(queryClient, bound.source.tenant.id),
        invalidateTenant(queryClient, bound.target.tenant.id),
      ]);
    } catch (error) {
      const problem = apiProblem(error);
      if (problem.kind === 'conflict') {
        if (problem.code === 'PREVIEW_EXPIRED') {
          setState({
            step: 'step1',
            notice: '预览已过期，请重新预览',
            error: null,
          });
          return;
        }
        if (problem.code === 'CURRENCY_MISMATCH') {
          setState({
            step: 'step1',
            notice: '来源与目标租户币种不一致，费率不能跨币种复制',
            error: null,
          });
          return;
        }
        if (
          problem.code === 'PREVIEW_STALE' ||
          problem.code === 'RATE_VERSION_CONFLICT'
        ) {
          await rebaseTarget(bound.target);
          setState({
            step: 'step1',
            notice: uncertain
              ? `可能已复制，请核对 ${bound.target.tenant.code} 的费率表；确认未复制时再重新预览`
              : '目标租户费率表已变化或预览已失效，已载入最新版本，请重新预览',
            error: null,
          });
          return;
        }
      }
      setState({
        ...bound,
        step: 'step2',
        error,
        uncertain: uncertain || problem.kind === 'unavailable',
      });
    }
  }

  const title = push ? '复制费率表到其他租户' : '复制其他租户的费率表';
  const subtitle =
    state.step === 'step1' || state.step === 'previewing'
      ? push
        ? `来源：${summary(self)}`
        : `目标：${summary(self)}`
      : `${state.source.tenant.code} → ${state.target.tenant.code} ${state.target.tenant.name} · ${state.target.tenant.currency}`;

  return (
    <ModalDialog
      open
      {...(busy ? {} : { onOpenChange: (open: boolean) => open || onClose() })}
      title={title}
      className="md:w-[720px]"
      fallbackFocus={fallbackFocus}
    >
      <DialogHeading
        headingRef={headingRef}
        title={title}
        subtitle={subtitle}
      />
      <StepList
        label="复制步骤"
        steps={[push ? '选择目标' : '选择来源', '预览变动', '完成']}
        position={stepIndex(state.step)}
        complete={state.step === 'done'}
      />
      {state.step === 'step1' || state.step === 'previewing' ? (
        <ChooseTenant
          direction={direction}
          self={self}
          picked={picked}
          pickError={pickError}
          notice={state.step === 'step1' ? state.notice : null}
          error={state.step === 'step1' ? state.error : null}
          blocked={blocked}
          busy={state.step === 'previewing'}
          choice={choice}
          scheduleError={scheduleError}
          onPick={(tenant) => void pick(tenant)}
          onRetryPick={() => {
            if (picked?.status === 'error') void pick(picked.tenant);
          }}
          onChoice={(value) => {
            setChoice(value);
            setScheduleError(undefined);
          }}
          onCancel={onClose}
          onNext={() => void runPreview()}
        />
      ) : state.step === 'done' ? (
        <CopyDone state={state} direction={direction} onClose={onClose} />
      ) : (
        <PreviewChanges
          preview={state.preview}
          unchanged={
            tableSizes(state.target.entryCount, state.preview.counts).unchanged
          }
          schedule={state.schedule}
          labels={copyLabels(state.target.tenant.code)}
          error={state.step === 'step2' ? state.error : null}
          uncertain={state.uncertain}
          busy={state.step === 'committing'}
          onBack={() => setState({ step: 'step1', notice: null, error: null })}
          onCancel={onClose}
          onConfirm={() => {
            if (state.step === 'step2') void runCommit(state);
          }}
        />
      )}
    </ModalDialog>
  );
}

function copyLabels(code: string): PreviewLabels {
  return {
    summary: `${code} 的费率表将`,
    columns: { before: `${code} 当前`, after: '复制后' },
    overwrite: code,
    confirm: `确认覆盖 ${code}`,
    busy: '正在复制…',
    networkMessage: `无法确认是否已复制，请核对 ${code} 的费率表后再操作。`,
    uncertainNote:
      '上次确认复制的结果未知。再次确认不会重复复制：如已复制，系统会提示核对。',
  };
}

function ChooseTenant({
  direction,
  self,
  picked,
  pickError,
  notice,
  error,
  blocked,
  busy,
  choice,
  scheduleError,
  onPick,
  onRetryPick,
  onChoice,
  onCancel,
  onNext,
}: {
  direction: RateCopyDirection;
  self: CopySide;
  picked: Picked | null;
  pickError: string | null;
  notice: string | null;
  error: unknown;
  blocked: boolean;
  busy: boolean;
  choice: ScheduleChoice;
  scheduleError: string | undefined;
  onPick: (tenant: CopyTenant) => void;
  onRetryPick: () => void;
  onChoice: (choice: ScheduleChoice) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const id = useId();
  const push = direction === 'push';
  const pickedTenant =
    picked === null
      ? null
      : picked.status === 'ready'
        ? picked.side.tenant
        : picked.tenant;
  return (
    <>
      {notice ? (
        <Alert variant="warning" role="status">
          <AlertTitle className="col-start-1">{notice}</AlertTitle>
        </Alert>
      ) : null}
      <Alert variant="warning" role="note" className="px-3.5 py-3">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>
          {push
            ? '将覆盖目标租户的整张费率表'
            : `将覆盖 ${self.tenant.code} 的整张费率表`}
        </AlertTitle>
        <AlertDescription className="text-foreground">
          {push ? '目标租户' : '本租户'}
          现有费率会被替换，来源中没有的前缀将被删除。
        </AlertDescription>
      </Alert>
      <TenantPicker
        label={push ? '目标租户' : '来源租户'}
        currency={self.tenant.currency}
        excludeId={self.tenant.id}
        selectedId={pickedTenant?.id ?? null}
        disabled={busy}
        onPick={onPick}
      />
      {picked?.status === 'error' ? (
        <div className="flex flex-col items-start gap-2">
          <ProblemAlert error={picked.error} />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={onRetryPick}
          >
            重新读取费率表
          </Button>
        </div>
      ) : null}
      {pickError ? (
        <span role="alert" className="text-xs text-err">
          {pickError}
        </span>
      ) : null}
      <ScheduleField
        choice={choice}
        error={scheduleError}
        disabled={busy}
        onChange={onChoice}
      />
      {error ? <ProblemAlert error={error} /> : null}
      {blocked ? (
        <span id={`${id}-blocked`} className="text-[13px] text-warn">
          {targetScheduledMessage}
        </span>
      ) : null}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        {pickedTenant ? (
          <span className="text-[13px] text-muted-foreground md:flex-1">
            已选：
            <span className="text-foreground">
              {pickedTenant.code} {pickedTenant.name}
            </span>
            {picked?.status === 'ready'
              ? ` · ${picked.side.entryCount} 条`
              : picked?.status === 'loading'
                ? ' · 正在读取费率表…'
                : null}
          </span>
        ) : (
          <span className="hidden md:block md:flex-1" />
        )}
        <div className="flex flex-col-reverse gap-2 md:flex-row">
          <Button
            variant="outline"
            className="h-12 md:h-9"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </Button>
          <Button
            className="h-12 md:h-9"
            disabled={busy || blocked || picked?.status === 'loading'}
            aria-describedby={blocked ? `${id}-blocked` : undefined}
            onClick={onNext}
          >
            {busy ? '正在预览…' : '下一步：预览变动'}
          </Button>
        </div>
      </div>
    </>
  );
}

/** 同币种租户单选：按编码或名称搜索，只取第一页；不显示各租户费率条数（契约不提供）。 */
function TenantPicker({
  label,
  currency,
  excludeId,
  selectedId,
  disabled,
  onPick,
}: {
  label: string;
  currency: Currency;
  excludeId: string;
  selectedId: string | null;
  disabled: boolean;
  onPick: (tenant: CopyTenant) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const deferred = useDeferredValue(search.trim());
  const tenants = useQuery(
    apiQuery('adminTenants', {
      query: {
        currency,
        page: 1,
        pageSize: pickerPageSize,
        ...(deferred ? { search: deferred } : {}),
      },
    }),
  );
  const items =
    tenants.data?.items.filter((tenant) => tenant.id !== excludeId) ?? [];
  const more =
    tenants.data !== undefined &&
    tenants.data.pagination.total > tenants.data.items.length;
  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        aria-label="搜索租户编码或名称"
        placeholder="搜索租户编码或名称"
        maxLength={200}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <span id={`${id}-group`} className="text-xs text-muted-foreground">
        可选 · 同币种（{currency}）
      </span>
      {tenants.isError ? (
        <ProblemAlert
          error={tenants.error}
          onRefresh={() => void tenants.refetch()}
        />
      ) : !tenants.data ? (
        <div
          aria-busy
          aria-label="租户加载中"
          className="h-[120px] animate-pulse rounded-lg bg-skeleton"
        />
      ) : items.length === 0 ? (
        <span className="rounded-lg border border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
          {deferred ? '没有匹配的同币种租户' : '没有其他同币种租户'}
        </span>
      ) : (
        <div
          role="radiogroup"
          aria-label={label}
          aria-describedby={`${id}-group`}
          className="flex max-h-[220px] flex-col overflow-auto rounded-lg border border-border"
        >
          {items.map((tenant) => (
            <label
              key={tenant.id}
              className="flex cursor-pointer items-center gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0 has-checked:bg-brand-soft has-focus-visible:ring-[3px] has-focus-visible:ring-ring"
            >
              <input
                type="radio"
                name={`${id}-tenant`}
                checked={tenant.id === selectedId}
                disabled={disabled}
                onChange={() =>
                  onPick({
                    id: tenant.id,
                    code: tenant.code,
                    name: tenant.name,
                    currency: tenant.currency,
                  })
                }
                className="accent-primary"
              />
              <span className="font-mono">{tenant.code}</span>
              <span className="flex-1 truncate">{tenant.name}</span>
              {tenant.status === 'disabled' ? (
                <span className="text-xs text-muted-foreground">已停用</span>
              ) : null}
            </label>
          ))}
        </div>
      )}
      {more ? (
        <span className="text-xs text-muted-foreground">
          仅显示前 {pickerPageSize} 个，请输入编码或名称缩小范围
        </span>
      ) : null}
    </div>
  );
}

function CopyDone({
  state,
  direction,
  onClose,
}: {
  state: Extract<RateCopyState, { step: 'done' }>;
  direction: RateCopyDirection;
  onClose: () => void;
}) {
  const { counts } = state.preview;
  const code = state.target.tenant.code;
  const scheduled = state.schedule.kind === 'scheduled';
  const at = formatDateTime(state.response.version.effectiveFrom);
  return (
    <>
      <div
        role="status"
        className="flex flex-col items-center gap-2 py-4 text-center text-[13px]"
      >
        <span className="text-[17px] font-semibold text-ok">
          {scheduled ? `已复制到 ${code}，已排定新版本` : `已复制到 ${code}`}
        </span>
        <span className="tabular-nums">
          新增 {counts.added} · 修改 {counts.modified} · 删除 {counts.deleted}
        </span>
        <span className="tabular-nums">
          {scheduled
            ? `将于 ${at} 生效，此前继续使用当前费率`
            : `生效时间 ${at}`}
        </span>
        {state.response.auditId !== null ? (
          <span className="text-muted-foreground">已记入操作日志</span>
        ) : null}
      </div>
      <div className="flex justify-center gap-2">
        {direction === 'push' ? (
          <a
            href={`/admin/tenants/${state.target.tenant.id}?tab=rates`}
            className={cn(
              buttonVariants({ variant: 'outline' }),
              'h-12 md:h-9',
            )}
          >
            查看 {code} 费率
          </a>
        ) : null}
        <Button className="h-12 md:h-9" onClick={onClose}>
          完成
        </Button>
      </div>
    </>
  );
}
