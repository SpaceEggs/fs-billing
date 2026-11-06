import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { useDeferredValue, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  translate,
  type AdminRateSchedule,
  type AdminRateVersionResponse,
  type Currency,
} from '@fs-billing/shared';
import { useLocale } from '@/i18n';
import { Skeleton } from '../ui/skeleton';
import { Input } from '../ui/input';
import {
  apiQuery,
  invalidateTenant,
  useApiMutation,
} from '../../lib/admin-api';
import { apiProblem, csvRowText, fieldIssues } from '../../lib/api-problem';
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

/** 中文文案；英文界面用 `rates:copy.scheduledBlocked`。 */
export const targetScheduledMessage = translate(
  'zh',
  'rates:copy.scheduledBlocked',
);

function stepIndex(step: RateCopyState['step']) {
  if (step === 'step1' || step === 'previewing') return 0;
  if (step === 'done') return 2;
  return 1;
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
  const { t } = useTranslation(['rates', 'common']);
  const locale = useLocale();
  const summary = ({ tenant, entryCount }: CopySide) =>
    t('rates:copy.summary', {
      code: tenant.code,
      name: tenant.name,
      currency: tenant.currency,
      count: entryCount,
    });
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
      setPickError(
        push ? t('rates:copy.pickTarget') : t('rates:copy.pickSource'),
      );
      return;
    }
    const resolved = resolveSchedule(
      choice,
      Date.now(),
      DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
      locale,
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
          notice: t('rates:copy.previewFailed', {
            errors: result.errors
              .map((error) => csvRowText(error))
              .join(t('rates:copy.errorSeparator')),
          }),
          error: null,
        });
    } catch (error) {
      const problem = apiProblem(error);
      if (problem.kind === 'conflict') {
        if (problem.code === 'RATE_VERSION_CONFLICT') {
          await rebaseTarget(target);
          setState({
            step: 'step1',
            notice: t('rates:copy.conflictReloaded'),
            error: null,
          });
          return;
        }
        if (problem.code === 'CURRENCY_MISMATCH') {
          setState({
            step: 'step1',
            notice: t('rates:copy.currencyMismatch'),
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
            notice: t('rates:copy.previewExpired'),
            error: null,
          });
          return;
        }
        if (problem.code === 'CURRENCY_MISMATCH') {
          setState({
            step: 'step1',
            notice: t('rates:copy.currencyMismatch'),
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
              ? t('rates:copy.mayCopied', {
                  code: bound.target.tenant.code,
                })
              : t('rates:copy.staleReloaded'),
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

  const title = push ? t('rates:copy.titlePush') : t('rates:copy.titlePull');
  const subtitle =
    state.step === 'step1' || state.step === 'previewing'
      ? push
        ? t('rates:copy.source', { summary: summary(self) })
        : t('rates:copy.target', { summary: summary(self) })
      : `${state.source.tenant.code} → ${state.target.tenant.code} ${state.target.tenant.name} · ${state.target.tenant.currency}`;

  const labelsForCode = (code: string): PreviewLabels => ({
    summary: t('rates:copy.labelsSummary', { code }),
    columns: {
      before: t('rates:copy.labelsBefore', { code }),
      after: t('rates:copy.labelsAfter'),
    },
    overwrite: code,
    confirm: t('rates:copy.labelsConfirm', { code }),
    busy: t('rates:copy.labelsBusy'),
    networkMessage: t('rates:copy.labelsNetwork', { code }),
    uncertainNote: t('rates:copy.labelsUncertain'),
  });

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
        label={t('rates:copy.stepLabel')}
        steps={[
          push ? t('rates:copy.stepTarget') : t('rates:copy.stepSource'),
          t('rates:copy.stepPreview'),
          t('rates:copy.stepDone'),
        ]}
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
          labels={labelsForCode(state.target.tenant.code)}
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
  const { t } = useTranslation(['rates', 'common']);
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
      <Alert variant="warning" className="px-3.5 py-3">
        <TriangleAlertIcon aria-hidden />
        <AlertTitle>
          {push
            ? t('rates:copy.overwriteTitlePush')
            : t('rates:copy.overwriteTitlePull', { code: self.tenant.code })}
        </AlertTitle>
        <AlertDescription className="text-foreground!">
          {t('rates:copy.overwriteBody', {
            subject: push
              ? t('rates:copy.overwriteTarget')
              : t('rates:copy.overwriteSelf'),
          })}
        </AlertDescription>
      </Alert>
      <TenantPicker
        label={
          push ? t('rates:copy.pickerTarget') : t('rates:copy.pickerSource')
        }
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
            {t('rates:copy.retrySnapshot')}
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
          {t('rates:copy.scheduledBlocked')}
        </span>
      ) : null}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
        {pickedTenant ? (
          <span className="text-[13px] text-muted-foreground md:flex-1">
            {t('rates:copy.selected')}
            <span className="text-foreground">
              {pickedTenant.code} {pickedTenant.name}
            </span>
            {picked?.status === 'ready'
              ? t('rates:copy.selectedCount', {
                  count: picked.side.entryCount,
                })
              : picked?.status === 'loading'
                ? t('rates:copy.reading')
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
            {t('common:action.cancel')}
          </Button>
          <Button
            className="h-12 md:h-9"
            disabled={busy || blocked || picked?.status === 'loading'}
            aria-describedby={blocked ? `${id}-blocked` : undefined}
            onClick={onNext}
          >
            {busy ? t('rates:copy.previewing') : t('rates:copy.next')}
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
  const { t } = useTranslation(['rates', 'common']);
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
      <Input
        type="search"
        aria-label={t('rates:copy.pickerSearch')}
        placeholder={t('rates:copy.pickerSearch')}
        maxLength={200}
        value={search}
        disabled={disabled}
        onChange={(event) => setSearch(event.target.value)}
        className="h-9 text-sm sm:h-9"
      />
      <span id={`${id}-group`} className="text-xs text-muted-foreground">
        {t('rates:copy.pickerHint', { currency })}
      </span>
      {tenants.isError ? (
        <ProblemAlert
          error={tenants.error}
          onRefresh={() => void tenants.refetch()}
        />
      ) : !tenants.data ? (
        <Skeleton
          aria-busy
          aria-label={t('rates:copy.pickerLoading')}
          className="h-[120px] rounded-lg"
        />
      ) : items.length === 0 ? (
        <span className="rounded-lg border border-border px-3 py-4 text-center text-[13px] text-muted-foreground">
          {deferred
            ? t('rates:copy.pickerNoMatch')
            : t('rates:copy.pickerNoOthers')}
        </span>
      ) : (
        <RadioGroup
          aria-label={label}
          aria-describedby={`${id}-group`}
          value={selectedId ?? ''}
          disabled={disabled}
          onValueChange={(next) => {
            const tenant = items.find((item) => item.id === next);
            if (tenant)
              onPick({
                id: tenant.id,
                code: tenant.code,
                name: tenant.name,
                currency: tenant.currency,
              });
          }}
          className="flex max-h-[220px] flex-col gap-0 overflow-auto rounded-lg border border-border"
        >
          {items.map((tenant) => (
            <label
              key={tenant.id}
              className="flex cursor-pointer items-center gap-2.5 border-t border-border px-3 py-2 text-[13px] first:border-t-0 has-[[data-state=checked]]:bg-brand-soft"
            >
              <RadioGroupItem value={tenant.id} />
              <span className="font-mono">{tenant.code}</span>
              <span className="flex-1 truncate">{tenant.name}</span>
              {tenant.status === 'disabled' ? (
                <span className="text-xs text-muted-foreground">
                  {t('rates:copy.pickerDisabled')}
                </span>
              ) : null}
            </label>
          ))}
        </RadioGroup>
      )}
      {more ? (
        <span className="text-xs text-muted-foreground">
          {t('rates:copy.pickerMore', { count: pickerPageSize })}
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
  const { t } = useTranslation(['rates', 'common']);
  const locale = useLocale();
  const { counts } = state.preview;
  const code = state.target.tenant.code;
  const scheduled = state.schedule.kind === 'scheduled';
  const at = formatDateTime(state.response.version.effectiveFrom, locale);
  return (
    <>
      <div
        role="status"
        className="flex flex-col items-center gap-2 py-4 text-center text-[13px]"
      >
        <span className="text-[17px] font-semibold text-ok">
          {scheduled
            ? t('rates:copy.doneScheduled', { code })
            : t('rates:copy.doneEffective', { code })}
        </span>
        <span className="tabular-nums">
          {t('rates:copy.counts', {
            added: counts.added,
            modified: counts.modified,
            deleted: counts.deleted,
          })}
        </span>
        <span className="tabular-nums">
          {scheduled
            ? t('rates:copy.scheduledAt', { time: at })
            : t('rates:copy.effectiveAt', { time: at })}
        </span>
        {state.response.auditId !== null ? (
          <span className="text-muted-foreground">
            {t('rates:copy.audited')}
          </span>
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
            {t('rates:copy.viewRates', { code })}
          </a>
        ) : null}
        <Button className="h-12 md:h-9" onClick={onClose}>
          {t('rates:copy.done')}
        </Button>
      </div>
    </>
  );
}
