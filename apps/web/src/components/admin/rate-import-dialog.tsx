import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  type AdminCsvRowError,
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

const steps = ['上传', '预览与校验', '确认导入'] as const;

const scheduleDescriptions = {
  immediate: '确认导入后马上用于新呼叫',
  scheduled: '到点前继续使用当前费率',
};

const importLabels: PreviewLabels = {
  verified: '校验通过',
  summary: '将',
  confirm: '确认导入',
  busy: '正在导入…',
  networkMessage: '无法确认是否已导入，请核对费率表后再操作。',
  uncertainNote:
    '上次确认导入的结果未知。再次确认不会重复导入：如已导入，系统会提示核对。',
};

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
      setFileError('文件超过 2 MB 上限，请拆分或删减后重新选择');
      setFile(null);
      return;
    }
    if (selected.size === 0) {
      setFileError('文件为空，请重新选择');
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
          notice: '费率表已被修改，已载入最新版本，请重新预览',
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
          notice: '预览已过期，请重新预览',
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
            ? '可能已导入，请核对费率表；确认未导入时再重新预览'
            : '费率表已变化或预览已失效，已载入最新版本，请重新预览',
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
      ? `${state.file.name} · ${state.preview.encoding} · ${tableSizes(base.entryCount, state.preview.counts).rows} 条`
      : state.step === 'step2-errors'
        ? state.file.name
        : `${tenant.code} ${tenant.name}（${tenant.currency}）`;

  return (
    <ModalDialog
      open
      {...(busy ? {} : { onOpenChange: (open: boolean) => open || onClose() })}
      title="导入费率表"
      className={dialogWidth[state.step]}
      fallbackFocus={fallbackFocus}
    >
      <DialogHeading
        headingRef={headingRef}
        title="导入费率表"
        subtitle={subtitle}
      />
      <StepList
        label="导入步骤"
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
  const [dragging, setDragging] = useState(false);
  return (
    <>
      {notice ? (
        <div
          role="status"
          className="rounded-lg border border-warn-border bg-warn-soft px-3 py-2.5 text-[13px] font-semibold text-warn"
        >
          {notice}
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        <label
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
                {formatFileSize(file.size)} · 点击更换文件
              </span>
            </>
          ) : (
            <span className="font-medium">
              拖拽 CSV 文件到此处，或{' '}
              <span className="text-primary">点击选择文件</span>
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            支持 UTF-8 / GBK 编码（Excel 默认保存格式即可），系统自动识别编码
          </span>
          <input
            id={id}
            type="file"
            accept=".csv,text/csv"
            aria-label="选择 CSV 文件"
            disabled={busy}
            onChange={(event) => {
              onPick(event.target.files?.[0] ?? null);
              event.target.value = '';
            }}
            className="sr-only"
          />
        </label>
        {fileError ? (
          <span role="alert" className="text-xs text-err">
            {fileError}
          </span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground">
          <span>
            格式：
            <span className="font-mono text-foreground">
              ISO,Country,Destination Prefix,Description,Rate
            </span>
            <span className="ml-3">每行一个前缀，覆盖整张费率表</span>
            <span className="mt-1 block">
              说明会显示给客户，请勿填写内部备注
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
        descriptions={scheduleDescriptions}
        onChange={onChoice}
      />
      {error ? <ProblemAlert error={error} /> : null}
      {blocked ? (
        <span id={`${id}-blocked`} className="text-[13px] text-warn">
          已有排定的新版本，请先取消排定
        </span>
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
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
          disabled={busy || blocked || !file}
          aria-describedby={blocked ? `${id}-blocked` : undefined}
          onClick={onNext}
        >
          {busy ? '正在预览…' : '下一步：预览'}
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
  return (
    <>
      <Alert variant="error" className="rounded-[10px] px-4 py-3.5">
        <CircleAlertIcon aria-hidden />
        <AlertTitle className="text-[15px]">
          发现 {errors.length} 处错误，文件未导入
        </AlertTitle>
        <AlertDescription className="text-foreground">
          有任何一行出错，整个文件不导入。请修改后重新上传，当前费率表未做任何改动。
        </AlertDescription>
      </Alert>
      <div className="max-h-[320px] overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-[13px]">
          <thead className="sticky top-0 bg-muted text-xs text-muted-foreground">
            <tr>
              <th className="py-2 pr-2 pl-3.5 text-left font-medium whitespace-nowrap">
                行号
              </th>
              <th className="px-2 py-2 text-left font-medium">错误原因</th>
              <th className="py-2 pr-3.5 pl-2 text-left font-medium">
                原始内容
              </th>
            </tr>
          </thead>
          <tbody>
            {errors.map((error, index) => (
              <tr
                key={`${error.line}-${index}`}
                className="border-t border-border"
              >
                <td className="py-2 pr-2 pl-3.5 font-semibold whitespace-nowrap tabular-nums">
                  第 {error.line} 行
                </td>
                <td className="px-2 py-2 text-err">{error.reason}</td>
                <td className="py-2 pr-3.5 pl-2 font-mono break-all text-muted-foreground">
                  {csvRawLine(lines, error.line)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <span className="text-xs text-muted-foreground">
        校验规则：前缀只能是数字、不能重复；ISO
        为两位字母或留空；国家必填；费率不能为负；小数不超过 4 位。
      </span>
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onCancel}>
          取消
        </Button>
        <Button className="h-12 md:h-9" onClick={onRetry}>
          重新上传
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
  const { counts } = state.preview;
  const at = formatDateTime(state.response.version.effectiveFrom);
  return (
    <>
      <div
        role="status"
        className="flex flex-col items-center gap-2 py-4 text-center text-[13px]"
      >
        <span className="text-[17px] font-semibold text-ok">
          {state.scheduled ? '已导入，已排定新版本' : '已导入，已生效'}
        </span>
        <span className="tabular-nums">
          新增 {counts.added} · 修改 {counts.modified} · 删除 {counts.deleted}
        </span>
        <span className="tabular-nums">
          {state.scheduled
            ? `将于 ${at} 生效，此前继续使用当前费率`
            : `生效时间 ${at}，新呼叫按新费率计费`}
        </span>
        {state.response.auditId !== null ? (
          <span className="text-muted-foreground">已记入操作日志</span>
        ) : null}
      </div>
      <div className="flex justify-center">
        <Button className="h-12 md:h-9" onClick={onClose}>
          返回费率表
        </Button>
      </div>
    </>
  );
}

function formatFileSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
