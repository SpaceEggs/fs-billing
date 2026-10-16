import type {
  AdminRatePreviewResponse,
  AdminRateSchedule,
} from '@fs-billing/shared';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ProblemAlert } from './problem-alert';
import { RateChangesTable } from './rate-changes-table';

/** 导入与复制共用的整表预览（pages.md §3.6「复用导入流程的预览变动界面」）。 */
export type RatePreview = Extract<AdminRatePreviewResponse, { ok: true }>;

export function DialogHeading({
  headingRef,
  title,
  subtitle,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="m-0 text-[17px] font-semibold outline-none"
      >
        {title}
      </h2>
      <span className="text-[13px] text-muted-foreground">{subtitle}</span>
    </div>
  );
}

/** 步骤条：`position` 为当前步骤下标，`complete` 时全部打勾，`failedAt` 那一步标红。 */
export function StepList({
  label,
  steps,
  position,
  complete,
  failedAt,
}: {
  label: string;
  steps: readonly string[];
  position: number;
  complete: boolean;
  failedAt?: number | undefined;
}) {
  return (
    <ol
      aria-label={label}
      className="m-0 flex list-none items-center gap-2 p-0 text-[13px]"
    >
      {steps.map((step, index) => {
        const current = index === position;
        const done = index < position || complete;
        const error = index === failedAt;
        return (
          <li
            key={step}
            aria-current={current ? 'step' : undefined}
            className={cn(
              'flex items-center gap-1.5',
              index > position && 'text-muted-foreground',
              current && 'font-semibold',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-full border text-[11px]',
                error
                  ? 'border-err bg-err text-white'
                  : done
                    ? 'border-primary bg-primary text-primary-foreground'
                    : current
                      ? 'border-primary text-primary'
                      : 'border-input',
              )}
            >
              {error ? '!' : done ? '✓' : index + 1}
            </span>
            {step}
            {index < steps.length - 1 ? (
              <span aria-hidden className="mx-1 h-px w-6 bg-input" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export type PreviewLabels = {
  /** 计数句的主语，如「将」或「BJH003 的费率表将」。 */
  summary: string;
  /** 复制时为目标租户编码：删除提示前先醒目提示整表覆盖。 */
  overwrite?: string;
  confirm: string;
  busy: string;
  networkMessage: string;
  uncertainNote: string;
};

const deleteListLimit = 5;

export function PreviewChanges({
  preview,
  unchanged,
  schedule,
  labels,
  error,
  uncertain,
  busy,
  onBack,
  onCancel,
  onConfirm,
}: {
  preview: RatePreview;
  unchanged: number;
  schedule: AdminRateSchedule;
  labels: PreviewLabels;
  error: unknown;
  uncertain: boolean;
  busy: boolean;
  onBack: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { counts, changes } = preview;
  const deleted = changes.flatMap((change) =>
    change.kind === 'deleted' ? [change.before] : [],
  );
  const deletedList = deleted.length
    ? deleted
        .slice(0, deleteListLimit)
        .map((entry) => `${entry.prefix} ${entry.country}`)
        .join('、') +
      (deleted.length > deleteListLimit ? ` 等 ${deleted.length} 个前缀` : '')
    : null;
  return (
    <>
      <div className="flex flex-col gap-1 rounded-lg border border-ok-border bg-ok-soft px-3.5 py-3 text-[13px]">
        <span className="font-semibold text-ok">校验通过</span>
        <span className="tabular-nums">
          {labels.summary}新增 {counts.added} 条、修改 {counts.modified}{' '}
          条、删除 {counts.deleted} 条，其余 {unchanged} 条不变
        </span>
      </div>
      {labels.overwrite ? (
        <div className="rounded-lg border border-err-border bg-err-soft px-3.5 py-2.5 text-[13px] text-err">
          <span className="font-semibold">
            将覆盖 {labels.overwrite} 的整张费率表
          </span>
          {deletedList ? `；删除后，拨打 ${deletedList} 的呼叫将被拒绝` : null}
        </div>
      ) : deletedList ? (
        <div className="rounded-lg border border-err-border bg-err-soft px-3.5 py-2.5 text-[13px] text-err">
          <span className="font-semibold">
            删除后，拨打这些前缀的呼叫将被拒绝
          </span>
          ：{deletedList}
        </div>
      ) : null}
      {changes.length ? (
        <div className="max-h-[320px] overflow-auto rounded-lg border border-border">
          <RateChangesTable
            changes={changes}
            currency={preview.currency}
            showHeader
          />
        </div>
      ) : (
        <span className="text-[13px] text-muted-foreground">
          与当前费率表相同，没有变动。
        </span>
      )}
      <span className="text-[13px]">
        生效时间：
        <span className="font-semibold tabular-nums">
          {schedule.kind === 'scheduled'
            ? `${formatDateTime(schedule.effectiveFrom)} 起（北京时间）`
            : '立即生效'}
        </span>
      </span>
      {error ? (
        <ProblemAlert error={error} networkMessage={labels.networkMessage} />
      ) : null}
      {uncertain ? (
        <span className="text-xs text-muted-foreground">
          {labels.uncertainNote}
        </span>
      ) : null}
      <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={busy}
          onClick={onBack}
        >
          上一步
        </Button>
        <Button
          variant="outline"
          className="h-12 md:h-9"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </Button>
        <Button className="h-12 md:h-9" disabled={busy} onClick={onConfirm}>
          {busy ? labels.busy : labels.confirm}
        </Button>
      </div>
    </>
  );
}

/** 写入后的整表条数与不变的条数（条数，不是金额）。 */
export function tableSizes(entryCount: number, counts: RatePreview['counts']) {
  return {
    rows: entryCount + counts.added - counts.deleted,
    unchanged: entryCount - counts.modified - counts.deleted,
  };
}
