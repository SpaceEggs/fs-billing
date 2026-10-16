import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  type AdminRateEntry,
  type AdminRateVersionResponse,
  type Currency,
} from '@fs-billing/shared';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import { formatRate } from '../../lib/format';
import {
  rateChangePercent,
  rateEditFailure,
  resolveSchedule,
  scheduleBounds,
  validateRateEdit,
  type RateEditErrors,
  type ScheduleChoice,
} from '../../lib/rates';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ModalDialog } from '../ui/dialog';
import { Input } from '../ui/input';
import { Field, invalidClass } from './form-fields';
import { ProblemAlert } from './problem-alert';

export const rateUnit = {
  CNY: '元/分钟',
  USD: '$/分钟',
} as const satisfies Record<Currency, string>;

export type RateEditResult = {
  before: AdminRateEntry;
  after: AdminRateEntry;
  scheduled: boolean;
  response: AdminRateVersionResponse;
};

/**
 * 单条编辑（设计稿第二批 8a/8b）：先改国家/备注与费率，再确认涨跌与生效时间。
 * 指定时间为北京时间分钟（决定 g），秒固定 00，范围 [now, now + horizon]。
 */
export function RateEditDialog({
  tenant,
  baseVersionId,
  entry,
  hasScheduled,
  onClose,
  onDone,
}: {
  tenant: { id: string; code: string; currency: Currency };
  baseVersionId: string;
  entry: AdminRateEntry;
  /** 已有排定版本时服务端拒绝修改（决定 d：先取消排定，再修改，再重新排期）。 */
  hasScheduled: boolean;
  onClose: () => void;
  onDone: (result: RateEditResult) => void;
}) {
  const queryClient = useQueryClient();
  const edit = useApiMutation('adminRateEdit', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [draft, setDraft] = useState({
    country: entry.country,
    rate: entry.rate,
  });
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'immediate' });
  const [errors, setErrors] = useState<RateEditErrors>({});
  const [next, setNext] = useState<AdminRateEntry | null>(null);
  const [generalError, setGeneralError] = useState<unknown>(null);
  const unit = rateUnit[tenant.currency];

  function toConfirm() {
    const result = validateRateEdit(entry, draft);
    if ('errors' in result) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setNext(result.entry);
    setStep('confirm');
  }

  async function submit() {
    if (!next) return;
    const resolved = resolveSchedule(
      choice,
      Date.now(),
      DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
    );
    if ('error' in resolved) {
      setErrors({ effectiveFrom: resolved.error });
      return;
    }
    setErrors({});
    setGeneralError(null);
    try {
      const response = await edit.mutateAsync({
        params: { tenantId: tenant.id },
        body: { baseVersionId, entry: next, schedule: resolved.schedule },
      });
      onDone({
        before: entry,
        after: next,
        scheduled: resolved.schedule.kind === 'scheduled',
        response,
      });
    } catch (error) {
      const failure = rateEditFailure(error);
      setErrors(failure.fields);
      setStep(failure.step);
      setGeneralError(failure.general ? error : null);
    }
  }

  const problem = generalError ? apiProblem(generalError) : null;
  const versionConflict =
    problem?.kind === 'conflict' && problem.code === 'RATE_VERSION_CONFLICT';

  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open && !edit.isPending) onClose();
      }}
      title={step === 'form' ? '编辑费率' : '确认修改费率'}
      className="md:w-[500px]"
    >
      {step === 'form' ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[17px] font-semibold">编辑费率</h2>
            <span className="text-[13px] text-muted-foreground">
              {tenant.code} · {tenant.currency}
            </span>
          </div>
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="前缀" error={undefined}>
              {(props) => (
                <Input
                  {...props}
                  readOnly
                  value={entry.prefix}
                  className="bg-muted font-mono font-semibold text-muted-foreground"
                />
              )}
            </Field>
            <Field label="国家/备注" required error={errors.country}>
              {(props) => (
                <Input
                  {...props}
                  maxLength={200}
                  value={draft.country}
                  onChange={(event) =>
                    setDraft({ ...draft, country: event.target.value })
                  }
                  className={invalidClass(errors.country)}
                />
              )}
            </Field>
          </div>
          <Field
            label={`费率（${unit}）`}
            required
            error={errors.rate}
            hint={`当前 ${formatRate(entry.rate)} ${unit} · 最多 4 位小数，不能为负`}
          >
            {(props) => (
              <div
                className={cn(
                  'flex h-11 items-center overflow-hidden rounded-lg border border-input font-normal focus-within:ring-[3px] focus-within:ring-ring/50 md:h-10',
                  errors.rate && 'border-err',
                )}
              >
                <input
                  {...props}
                  inputMode="decimal"
                  autoComplete="off"
                  value={draft.rate}
                  onChange={(event) =>
                    setDraft({ ...draft, rate: event.target.value })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') toConfirm();
                  }}
                  className="h-full min-w-0 flex-1 bg-transparent px-3 text-right text-base tabular-nums outline-none md:text-sm"
                />
                <span
                  aria-hidden
                  className="flex h-full items-center border-l border-input px-3 text-[13px] text-muted-foreground"
                >
                  {unit}
                </span>
              </div>
            )}
          </Field>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
              取消
            </Button>
            <Button className="h-12 md:h-9" onClick={toConfirm}>
              下一步：确认
            </Button>
          </div>
        </>
      ) : next ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[17px] font-semibold">确认修改费率</h2>
            <span className="text-[13px] text-muted-foreground">
              {tenant.code} · {entry.prefix} {entry.country}
            </span>
          </div>
          <RateComparison before={entry} after={next} unit={unit} />
          <ScheduleField
            choice={choice}
            error={errors.effectiveFrom}
            disabled={edit.isPending}
            onChange={(value) => {
              setChoice(value);
              setErrors({});
            }}
          />
          <p className="m-0 text-[13px] leading-relaxed text-muted-foreground">
            {choice.kind === 'scheduled'
              ? `到点前继续按 ${formatRate(entry.rate)} 计费；已产生的话单和账单不受影响。将记入操作日志。`
              : '确认后立即按新费率计费；已产生的话单和账单不受影响。将记入操作日志。'}
          </p>
          {generalError ? (
            <div className="flex flex-col gap-2">
              <ProblemAlert
                error={generalError}
                networkMessage="无法确认是否已修改，请刷新费率表核对后再操作。"
                onRefresh={() => {
                  void invalidateTenant(queryClient, tenant.id);
                  onClose();
                }}
              />
              {versionConflict && hasScheduled ? (
                <span className="text-xs leading-normal text-muted-foreground">
                  已有排定的新版本时不能修改当前费率。如需修改，请先取消排定，修改后再重新排期。
                </span>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button
              variant="outline"
              className="h-12 md:h-9"
              disabled={edit.isPending}
              onClick={() => {
                setGeneralError(null);
                setStep('form');
              }}
            >
              返回修改
            </Button>
            <Button
              className="h-12 md:h-9"
              disabled={edit.isPending}
              onClick={() => void submit()}
            >
              确认修改
            </Button>
          </div>
        </>
      ) : null}
    </ModalDialog>
  );
}

function RateComparison({
  before,
  after,
  unit,
}: {
  before: AdminRateEntry;
  after: AdminRateEntry;
  unit: string;
}) {
  const percent = rateChangePercent(before.rate, after.rate);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-center gap-4 rounded-[10px] border border-border p-[18px] tabular-nums">
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted-foreground">旧费率</span>
          <span className="text-[22px] text-muted-foreground line-through">
            {formatRate(before.rate)}
          </span>
        </div>
        <span aria-hidden className="text-xl text-muted-foreground">
          →
        </span>
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted-foreground">新费率</span>
          <span className="text-[26px] font-bold">
            {formatRate(after.rate)}
          </span>
        </div>
        {percent ? (
          <span
            className={cn(
              'inline-flex h-[26px] items-center rounded-md border px-2.5 text-[13px] font-semibold',
              percent.rising
                ? 'border-err-border bg-err-soft text-err'
                : 'border-ok-border bg-ok-soft text-ok',
            )}
          >
            {percent.rising ? '涨' : '降'} {percent.text}
          </span>
        ) : null}
      </div>
      <span className="text-center text-xs text-muted-foreground">
        单位：{unit}
      </span>
      {after.country !== before.country ? (
        <span className="text-[13px]">
          国家/备注：
          <span className="text-muted-foreground line-through">
            {before.country}
          </span>{' '}
          → <span className="font-semibold">{after.country}</span>
        </span>
      ) : null}
    </div>
  );
}

/** 生效时间：立即，或北京时间分钟（单条编辑与整表导入共用）。 */
export function ScheduleField({
  choice,
  error,
  disabled,
  onChange,
}: {
  choice: ScheduleChoice;
  error: string | undefined;
  disabled: boolean;
  onChange: (choice: ScheduleChoice) => void;
}) {
  const id = useId();
  const [minute, setMinute] = useState(
    choice.kind === 'scheduled' ? choice.minute : '',
  );
  const [bounds] = useState(() =>
    scheduleBounds(Date.now(), DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS),
  );
  const options = [
    { kind: 'immediate', label: '立即生效' },
    { kind: 'scheduled', label: '指定时间生效' },
  ] as const;
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 text-sm font-medium">
      <legend className="mb-2 p-0">生效时间</legend>
      <div className="grid grid-cols-2 gap-2 font-normal">
        {options.map((option) => (
          <label
            key={option.kind}
            className="relative flex h-11 cursor-pointer items-center gap-2.5 rounded-lg border border-input px-3 has-checked:border-primary has-checked:bg-brand-soft has-checked:font-medium has-checked:text-primary has-focus-visible:ring-[3px] has-focus-visible:ring-ring md:h-10"
          >
            <input
              type="radio"
              name={id}
              value={option.kind}
              disabled={disabled}
              checked={choice.kind === option.kind}
              onChange={() =>
                onChange(
                  option.kind === 'immediate'
                    ? { kind: 'immediate' }
                    : { kind: 'scheduled', minute },
                )
              }
              className="size-4 accent-primary"
            />
            {option.label}
          </label>
        ))}
      </div>
      {choice.kind === 'scheduled' ? (
        <Field label="指定生效时间（北京时间）" error={error}>
          {(props) => (
            <Input
              {...props}
              type="datetime-local"
              step={60}
              min={bounds.min}
              max={bounds.max}
              disabled={disabled}
              value={minute}
              onChange={(event) => {
                setMinute(event.target.value);
                onChange({ kind: 'scheduled', minute: event.target.value });
              }}
              className={cn('tabular-nums', invalidClass(error))}
            />
          )}
        </Field>
      ) : error ? (
        <span className="text-xs font-normal text-err">{error}</span>
      ) : null}
    </fieldset>
  );
}
