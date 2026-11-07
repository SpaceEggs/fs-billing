import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from '@/components/ui/table';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  type AdminCsvRowError,
  type AdminRateSchedule,
  type AdminRateVersionResponse,
  type Currency,
} from '@fs-billing/shared';
import { useLocale } from '@/i18n';
import { Label } from '../ui/label';
import {
  apiQuery,
  invalidateTenant,
  useApiMutation,
} from '../../lib/admin-api';
import { apiProblem, csvRowText, fieldIssues } from '../../lib/api-problem';
import { formatDateTime } from '../../lib/format';
import {
  csvRawLine,
  csvTooLarge,
  decodeCsvLines,
  fileToBase64,
} from '../../lib/rate-csv';
import { resolveSchedule, type ScheduleChoice } from '../../lib/rates';
import { cn } from '../../lib/utils';
import { CircleAlertIcon } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { ProblemAlert } from './problem-alert';
import {
  DialogHeading,
  PreviewChanges,
  StepList,
  tableSizes,
  type PreviewLabels,
  type RatePreview,
} from './rate-preview';
import { RateCsvTemplateLink } from './rate-csv-template-link';
import { ScheduleField } from './rate-edit-dialog';

type Preview = RatePreview;

/** 预览所据的当前版本，打开时取快照；冲突后按刷新到的完整表重新取。 */
export type RateImportBase = {
  versionId: string;
  entryCount: number;
  hasScheduled: boolean;
};

/**
 * 第 2 步起记下发去预览的那个文件，副标题与「原始内容」都取它，不取之后选中的文件。
 * `uncertain`：确认导入时网络中断或服务端 5xx，不知道是否已导入。
 * 之后再确认收到 PREVIEW_STALE / RATE_VERSION_CONFLICT，多半是上次其实已导入。
 */
export type RateImportState =
  | { step: 'step1'; notice: string | null; error: unknown }
  | { step: 'previewing' }
  | {
      step: 'step2-ok';
      file: File;
      preview: Preview;
      schedule: AdminRateSchedule;
      error: unknown;
      uncertain: boolean;
    }
  | {
      step: 'step2-errors';
      file: File;
      errors: AdminCsvRowError[];
      lines: string[] | null;
    }
  | {
      step: 'committing';
      file: File;
      preview: Preview;
      schedule: AdminRateSchedule;
      uncertain: boolean;
    }
  | {
      step: 'done';
      preview: Preview;
      scheduled: boolean;
      response: AdminRateVersionResponse;
    };

const stepKeys = [
  'rates:import.steps.upload',
  'rates:import.steps.preview',
  'rates:import.steps.commit',
] as const;

const scheduleDescriptionKeys = {
  immediate: 'rates:import.scheduleImmediate',
  scheduled: 'rates:import.scheduleScheduled',
} as const;

/** 电脑宽度随步骤变化（第二批导入稿）：上传 600、校验失败 620、预览 720；完成步保留步骤条，沿用 720。 */
const dialogWidth = {
  step1: 'md:w-[600px]',
  previewing: 'md:w-[600px]',
  'step2-errors': 'md:w-[620px]',
  'step2-ok': 'md:w-[720px]',
  committing: 'md:w-[720px]',
  done: 'md:w-[720px]',
} as const satisfies Record<RateImportState['step'], string>;

function stepIndex(step: RateImportState['step']) {
  if (step === 'step1' || step === 'previewing') return 0;
  if (step === 'done') return 2;
  return 1;
}

/**
 * 导入 CSV（设计稿第二批「导入 CSV」、CSV 导入原型；pages.md §3.6）：上传 → 预览与校验 → 确认导入。
 * 预览过期、过时或版本冲突时退回第 1 步，保留已选文件与生效时间（G5）。确认导入不自动重试。
 */
export function RateImportDialog({
  tenant,
  base: initialBase,
  onClose,
  fallbackFocus,
}: {
  tenant: { id: string; code: string; name: string; currency: Currency };
  base: RateImportBase;
  onClose: () => void;
  fallbackFocus: React.RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(['rates', 'common']);
  const steps = stepKeys.map((key) => t(key));
  const importLabels: PreviewLabels = {
    verified: t('rates:import.verified'),
    summary: t('rates:import.summary'),
    confirm: t('rates:import.confirm'),
    busy: t('rates:import.busy'),
    networkMessage: t('rates:import.networkMessage'),
    uncertainNote: t('rates:import.uncertainNote'),
  };
  const preview = useApiMutation('adminRateImportPreview');
  const commit = useApiMutation('adminRateImportCommit', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const [base, setBase] = useState(initialBase);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'immediate' });
  const [scheduleError, setScheduleError] = useState<string | undefined>();
  const [state, setState] = useState<RateImportState>({
    step: 'step1',
    notice: null,
    error: null,
  });
  const headingRef = useRef<HTMLHeadingElement>(null);
  // 每次预览或换文件加一；应答回来时编号已变就丢弃，过时的预览不会显示成可确认。
  const previewRequest = useRef(0);
  const busy = state.step === 'previewing' || state.step === 'committing';

  useEffect(() => {
    if (!busy) headingRef.current?.focus();
  }, [state.step, busy]);

  function pick(selected: File | null) {
    if (!selected || busy) return;
    previewRequest.current += 1;
    if (csvTooLarge(selected.size)) {
      setFileError(t('rates:import.fileTooLarge'));
      setFile(null);
      return;
    }
    if (selected.size === 0) {
      setFileError(t('rates:import.fileEmpty'));
      setFile(null);
      return;
    }
    setFileError(null);
    setFile(selected);
    setState({ step: 'step1', notice: null, error: null });
  }

  /** 按刷新后的完整表重新取快照，下次预览即与最新版本比较。 */
  async function rebase() {
    await invalidateTenant(queryClient, tenant.id);
    try {
      const fresh = await queryClient.fetchQuery(
        apiQuery('adminRates', { params: { tenantId: tenant.id }, query: {} }),
      );
      setBase({
        versionId: fresh.current.id,
        entryCount: fresh.current.entries.length,
        hasScheduled: fresh.scheduled.length > 0,
      });
    } catch {
      // 刷新失败时保留原快照，再次预览会重新报冲突。
    }
  }

  async function runPreview() {
    if (!file) return;
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
    const request = (previewRequest.current += 1);
    const sent = file;
    const latest = () => request === previewRequest.current;
    try {
      const result = await preview.mutateAsync({
        params: { tenantId: tenant.id },
        body: {
          file: {
            filename: sent.name,
            contentBase64: await fileToBase64(sent),
          },
          baseVersionId: base.versionId,
          schedule: resolved.schedule,
        },
      });
      if (!latest()) return;
      if (result.ok)
        setState({
          step: 'step2-ok',
          file: sent,
          preview: result,
          schedule: resolved.schedule,
          error: null,
          uncertain: false,
        });
      else await showRowErrors(sent, result.errors, latest);
    } catch (error) {
      if (!latest()) return;
      const problem = apiProblem(error);
      if (problem.kind === 'csv-invalid')
        return showRowErrors(sent, problem.rows, latest);
      if (
        problem.kind === 'conflict' &&
        problem.code === 'RATE_VERSION_CONFLICT'
      ) {
        await rebase();
        if (!latest()) return;
        setState({
          step: 'step1',
          notice: t('rates:import.conflictReloaded'),
          error: null,
        });
        return;
      }
      setScheduleError(fieldIssues(problem).get('schedule.effectiveFrom'));
      setState({ step: 'step1', notice: null, error });
    }
  }

  async function showRowErrors(
    sent: File,
    errors: AdminCsvRowError[],
    latest: () => boolean,
  ) {
    let lines: string[] | null = null;
    try {
      lines = decodeCsvLines(new Uint8Array(await sent.arrayBuffer()));
    } catch {
      // 读不出原文时「原始内容」显示「—」。
    }
    if (latest()) setState({ step: 'step2-errors', file: sent, errors, lines });
  }

  async function runCommit(
    current: Extract<RateImportState, { step: 'step2-ok' }>,
  ) {
    const { file: sent, preview: result, schedule, uncertain } = current;
    setState({
      step: 'committing',
      file: sent,
      preview: result,
      schedule,
      uncertain,
    });
    try {
      const response = await commit.mutateAsync({
        params: { tenantId: tenant.id },
        body: { previewId: result.previewId },
      });
      setState({
        step: 'done',
        preview: result,
        scheduled: schedule.kind === 'scheduled',
        response,
      });
    } catch (error) {
      const problem = apiProblem(error);
      if (problem.kind === 'conflict' && problem.code === 'PREVIEW_EXPIRED') {
        setState({
          step: 'step1',
          notice: t('rates:import.previewExpired'),
          error: null,
        });
        return;
      }
      if (
        problem.kind === 'conflict' &&
        (problem.code === 'PREVIEW_STALE' ||
          problem.code === 'RATE_VERSION_CONFLICT')
      ) {
        await rebase();
        setState({
          step: 'step1',
          notice: uncertain
            ? t('rates:import.mayImported')
            : t('rates:import.staleReloaded'),
          error: null,
        });
        return;
      }
      setState({
        step: 'step2-ok',
        file: sent,
        preview: result,
        schedule,
        error,
        uncertain: uncertain || problem.kind === 'unavailable',
      });
    }
  }

  const subtitle =
    state.step === 'step2-ok' || state.step === 'committing'
      ? `${state.file.name} · ${state.preview.encoding} · ${t('rates:import.rows', { count: tableSizes(base.entryCount, state.preview.counts).rows })}`
      : state.step === 'step2-errors'
        ? state.file.name
        : t('rates:import.tenantSubtitle', {
            code: tenant.code,
            name: tenant.name,
            currency: tenant.currency,
          });

  return (
    <ModalDialog
      open
      {...(busy ? {} : { onOpenChange: (open: boolean) => open || onClose() })}
      title={t('rates:import.title')}
      className={dialogWidth[state.step]}
      fallbackFocus={fallbackFocus}
    >
      <DialogHeading
        headingRef={headingRef}
        title={t('rates:import.title')}
        subtitle={subtitle}
      />
      <StepList
        label={t('rates:import.stepLabel')}
        steps={steps}
        position={stepIndex(state.step)}
        complete={state.step === 'done'}
        failedAt={state.step === 'step2-errors' ? 1 : undefined}
      />

      {state.step === 'step1' || state.step === 'previewing' ? (
        <Upload
          file={file}
          fileError={fileError}
          notice={state.step === 'step1' ? state.notice : null}
          error={state.step === 'step1' ? state.error : null}
          blocked={base.hasScheduled}
          busy={state.step === 'previewing'}
          choice={choice}
          scheduleError={scheduleError}
          onPick={pick}
          onChoice={(value) => {
            setChoice(value);
            setScheduleError(undefined);
          }}
          onCancel={onClose}
          onNext={() => void runPreview()}
        />
      ) : state.step === 'step2-errors' ? (
        <RowErrors
          errors={state.errors}
          lines={state.lines}
          onCancel={onClose}
          onRetry={() => setState({ step: 'step1', notice: null, error: null })}
        />
      ) : state.step === 'step2-ok' || state.step === 'committing' ? (
        <PreviewChanges
          preview={state.preview}
          unchanged={
            tableSizes(base.entryCount, state.preview.counts).unchanged
          }
          schedule={state.schedule}
          labels={importLabels}
          error={state.step === 'step2-ok' ? state.error : null}
          uncertain={state.uncertain}
          busy={state.step === 'committing'}
          onBack={() => setState({ step: 'step1', notice: null, error: null })}
          onCancel={onClose}
          onConfirm={() => {
            if (state.step === 'step2-ok') void runCommit(state);
          }}
        />
      ) : (
        <ImportDone state={state} onClose={onClose} />
      )}
    </ModalDialog>
  );
}

function Upload({
  file,
  fileError,
  notice,
  error,
  blocked,
  busy,
  choice,
  scheduleError,
  onPick,
  onChoice,
  onCancel,
  onNext,
}: {
  file: File | null;
  fileError: string | null;
  notice: string | null;
  error: unknown;
  blocked: boolean;
  busy: boolean;
  choice: ScheduleChoice;
  scheduleError: string | undefined;
  onPick: (file: File | null) => void;
  onChoice: (choice: ScheduleChoice) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const id = useId();
  const { t } = useTranslation(['rates', 'common']);
  const [dragging, setDragging] = useState(false);
  return (
    <>
      {notice ? (
        <Alert variant="warning" role="status" className="font-semibold">
          {notice}
        </Alert>
      ) : null}
      <div className="flex flex-col gap-2">
        <Label
          htmlFor={id}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            onPick(event.dataTransfer.files[0] ?? null);
          }}
          className={cn(
            'flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border-[1.5px] border-dashed border-input px-4 py-8 text-center text-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring',
            dragging && 'border-primary bg-brand-soft',
            fileError && 'border-err',
          )}
        >
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-[10px] bg-muted text-lg text-muted-foreground"
          >
            ⤒
          </span>
          {file ? (
            <>
              <span className="font-semibold break-all">{file.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {formatFileSize(file.size)} · {t('rates:import.replaceFile')}
              </span>
            </>
          ) : (
            <span className="font-medium">
              {t('rates:import.dropHint')}{' '}
              <span className="text-primary">
                {t('rates:import.chooseFile')}
              </span>
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {t('rates:import.encodingHint')}
          </span>
          <input
            id={id}
            type="file"
            accept=".csv,text/csv"
            aria-label={t('rates:import.selectFile')}
            disabled={busy}
            onChange={(event) => {
              onPick(event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
            className="sr-only"
          />
        </Label>
        {fileError ? (
          <span role="alert" className="text-xs text-err">
            {fileError}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
          <span>
            {t('rates:import.formatLabel')}
            <span className="font-mono text-foreground">
              ISO,Country,Destination Prefix,Description,Rate
            </span>
            <span className="ml-3">{t('rates:import.perRow')}</span>
            <span className="mt-1 block">
              {t('rates:import.descriptionWarning')}
            </span>
          </span>
          <span className="flex-1" />
          <RateCsvTemplateLink />
        </div>
      </div>
      <ScheduleField
        choice={choice}
        error={scheduleError}
        disabled={busy}
        descriptions={{
          immediate: t(scheduleDescriptionKeys.immediate),
          scheduled: t(scheduleDescriptionKeys.scheduled),
        }}
        onChange={onChoice}
      />
      {error ? <ProblemAlert error={error} /> : null}
      {blocked ? (
        <span id={`${id}-blocked`} className="text-[13px] text-warn">
          {t('rates:import.blocked')}
        </span>
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
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
          disabled={busy || blocked || !file}
          aria-describedby={blocked ? `${id}-blocked` : undefined}
          onClick={onNext}
        >
          {busy ? t('rates:import.previewing') : t('rates:import.next')}
        </Button>
      </div>
    </>
  );
}

function RowErrors({
  errors,
  lines,
  onCancel,
  onRetry,
}: {
  errors: AdminCsvRowError[];
  lines: string[] | null;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation(['rates', 'common']);
  return (
    <>
      <Alert variant="error" className="rounded-[10px] px-4 py-3.5">
        <CircleAlertIcon aria-hidden />
        <AlertTitle className="text-[15px]">
          {t('rates:import.errorsTitle', { count: errors.length })}
        </AlertTitle>
        <AlertDescription className="text-foreground!">
          {t('rates:import.errorsBody')}
        </AlertDescription>
      </Alert>
      <div className="max-h-[320px] overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader className="sticky top-0">
            <TableRow className="border-t-0">
              <TableHead className="py-2 pr-2 pl-3.5 whitespace-nowrap">
                {t('rates:import.line')}
              </TableHead>
              <TableHead className="px-2 py-2">
                {t('rates:import.reason')}
              </TableHead>
              <TableHead className="py-2 pr-3.5 pl-2">
                {t('rates:import.raw')}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {errors.map((error, index) => (
              <TableRow key={`${error.line}-${index}`}>
                <TableCell className="py-2 pr-2 pl-3.5 font-semibold whitespace-nowrap tabular-nums">
                  {t('rates:import.lineNumber', { line: error.line })}
                </TableCell>
                <TableCell className="px-2 py-2 text-err">
                  {csvRowText(error)}
                </TableCell>
                <TableCell className="py-2 pr-3.5 pl-2 font-mono break-all text-muted-foreground">
                  {csvRawLine(lines, error.line)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <span className="text-xs text-muted-foreground">
        {t('rates:import.rules')}
      </span>
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onCancel}>
          {t('common:action.cancel')}
        </Button>
        <Button className="h-12 md:h-9" onClick={onRetry}>
          {t('rates:import.retry')}
        </Button>
      </div>
    </>
  );
}

function ImportDone({
  state,
  onClose,
}: {
  state: Extract<RateImportState, { step: 'done' }>;
  onClose: () => void;
}) {
  const { t } = useTranslation(['rates', 'common']);
  const locale = useLocale();
  const { counts } = state.preview;
  const at = formatDateTime(state.response.version.effectiveFrom, locale);
  return (
    <>
      <div
        role="status"
        className="flex flex-col items-center gap-2 py-4 text-center text-[13px]"
      >
        <span className="text-[17px] font-semibold text-ok">
          {state.scheduled
            ? t('rates:import.doneScheduled')
            : t('rates:import.doneEffective')}
        </span>
        <span className="tabular-nums">
          {t('rates:import.counts', {
            added: counts.added,
            modified: counts.modified,
            deleted: counts.deleted,
          })}
        </span>
        <span className="tabular-nums">
          {state.scheduled
            ? t('rates:import.scheduledAt', { time: at })
            : t('rates:import.effectiveAt', { time: at })}
        </span>
        {state.response.auditId !== null ? (
          <span className="text-muted-foreground">
            {t('rates:import.audited')}
          </span>
        ) : null}
      </div>
      <div className="flex justify-center">
        <Button className="h-12 md:h-9" onClick={onClose}>
          {t('rates:import.backToTable')}
        </Button>
      </div>
    </>
  );
}

function formatFileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
