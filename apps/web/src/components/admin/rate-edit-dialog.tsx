import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from '../ui/input-group';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS,
  formatCountryLabel,
  translate,
  type AdminRateEntry,
  type AdminRateVersionResponse,
  type Currency,
  type Locale,
} from '@fs-billing/shared';
import { useLocale } from '@/i18n';
import { Badge } from '../ui/badge';
import { invalidateTenant, useApiMutation } from '../../lib/admin-api';
import { apiProblem } from '../../lib/api-problem';
import { formatRate } from '../../lib/format';
import {
  blankAsDash,
  rateChangePercent,
  rateEditFailure,
  rateEntryFields,
  resolveSchedule,
  scheduleBounds,
  validateRateEdit,
  type RateEditDraft,
  type RateEditErrors,
  type ScheduleChoice,
} from '../../lib/rates';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import { ModalDialog } from '../modal-dialog';
import { Input } from '../ui/input';
import { Field, invalidClass } from './form-fields';
import { ProblemAlert } from './problem-alert';

/** 中文费率单位；其他语言用 `format:rateUnit`。 */
export const rateUnit = {
  CNY: translate('zh', 'format:rateUnit.cny'),
  USD: translate('zh', 'format:rateUnit.usd'),
} as const satisfies Record<Currency, string>;

export type RateEditResult = {
  before: AdminRateEntry;
  after: AdminRateEntry;
  scheduled: boolean;
  response: AdminRateVersionResponse;
};

/**
 * 单条编辑（设计稿第二批 8a/8b）：先改 ISO、国家、说明与费率，再确认涨跌与生效时间。
 * 指定时间为北京时间分钟（决定 g），秒固定 00，范围 [now, now + horizon]。
 */
export function RateEditDialog({
  tenant,
  baseVersionId,
  entry,
  hasScheduled,
  onClose,
  onDone,
  fallbackFocus,
}: {
  tenant: { id: string; code: string; currency: Currency };
  baseVersionId: string;
  entry: AdminRateEntry;
  /** 已有排定版本时服务端拒绝修改（决定 d：先取消排定，再修改，再重新排期）。 */
  hasScheduled: boolean;
  onClose: () => void;
  onDone: (result: RateEditResult) => void;
  /** 排定成功后打开者（编辑按钮）随即禁用，焦点回到这里。 */
  fallbackFocus: React.RefObject<HTMLElement | null>;
}) {
  const queryClient = useQueryClient();
  const { t } = useTranslation(['rates', 'common', 'format']);
  const locale = useLocale();
  const edit = useApiMutation('adminRateEdit', {
    invalidate: (client, input) =>
      invalidateTenant(client, input.params.tenantId),
  });
  const [step, setStep] = useState<'form' | 'confirm'>('form');
  const [draft, setDraft] = useState<RateEditDraft>({
    iso: entry.iso,
    country: entry.country,
    description: entry.description,
    rate: entry.rate,
  });
  const [choice, setChoice] = useState<ScheduleChoice>({ kind: 'immediate' });
  const [errors, setErrors] = useState<RateEditErrors>({});
  const [next, setNext] = useState<AdminRateEntry | null>(null);
  const [generalError, setGeneralError] = useState<unknown>(null);
  const unit = t(
    tenant.currency === 'CNY' ? 'format:rateUnit.cny' : 'format:rateUnit.usd',
  );

  function toConfirm() {
    const result = validateRateEdit(entry, draft, locale);
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
      const failure = rateEditFailure(error, locale);
      setErrors(failure.fields);
      setStep(failure.step);
      setGeneralError(failure.general ? error : null);
    }
  }

  const bind = (field: keyof RateEditDraft) => ({
    value: draft[field],
    onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
      setDraft({ ...draft, [field]: event.target.value }),
  });

  const problem = generalError ? apiProblem(generalError) : null;
  const versionConflict =
    problem?.kind === 'conflict' && problem.code === 'RATE_VERSION_CONFLICT';

  return (
    <ModalDialog
      open
      {...(edit.isPending
        ? {}
        : { onOpenChange: (open: boolean) => open || onClose() })}
      title={
        step === 'form' ? t('rates:edit.title') : t('rates:edit.confirmTitle')
      }
      fallbackFocus={fallbackFocus}
      className="md:w-[500px]"
    >
      {step === 'form' ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[17px] font-semibold">
              {t('rates:edit.title')}
            </h2>
            <span className="text-[13px] text-muted-foreground">
              {tenant.code} · {tenant.currency}
            </span>
          </div>
          <div className="grid grid-cols-[1fr_1fr] gap-3">
            <Field label={t('rates:edit.prefixLabel')} error={undefined}>
              {(props) => (
                <Input
                  {...props}
                  readOnly
                  value={entry.prefix}
                  className="bg-muted font-mono font-semibold text-muted-foreground"
                />
              )}
            </Field>
            <Field
              label={t('rates:field.iso')}
              error={errors.iso}
              hint={t('rates:edit.isoHint')}
            >
              {(props) => (
                <Input
                  {...props}
                  autoCapitalize="characters"
                  {...bind('iso')}
                  className={cn('font-mono', invalidClass(errors.iso))}
                />
              )}
            </Field>
          </div>
          <Field
            label={t('rates:field.country')}
            required
            error={errors.country}
          >
            {(props) => (
              <Input
                {...props}
                maxLength={200}
                {...bind('country')}
                className={invalidClass(errors.country)}
              />
            )}
          </Field>
          <Field
            label={t('rates:field.description')}
            error={errors.description}
            hint={t('rates:edit.descriptionHint')}
          >
            {(props) => (
              <Input
                {...props}
                maxLength={200}
                {...bind('description')}
                className={invalidClass(errors.description)}
              />
            )}
          </Field>
          <Field
            label={t('rates:edit.rateLabel', { unit })}
            required
            error={errors.rate}
            hint={t('rates:edit.rateHint', {
              current: formatRate(entry.rate, {
                currency: tenant.currency,
                unit: true,
                locale,
              }),
            })}
          >
            {(props) => (
              <InputGroup
                className={cn('max-md:h-11', errors.rate && 'border-err')}
              >
                <InputGroupInput
                  {...props}
                  inputMode="decimal"
                  autoComplete="off"
                  {...bind('rate')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') toConfirm();
                  }}
                  className="text-right tabular-nums"
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>{unit}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            )}
          </Field>
          <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
            <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
              {t('common:action.cancel')}
            </Button>
            <Button className="h-12 md:h-9" onClick={toConfirm}>
              {t('rates:edit.next')}
            </Button>
          </div>
        </>
      ) : next ? (
        <>
          <div className="flex flex-col gap-1">
            <h2 className="m-0 text-[17px] font-semibold">
              {t('rates:edit.confirmTitle')}
            </h2>
            <span className="text-[13px] text-muted-foreground">
              {tenant.code} · {entry.prefix}{' '}
              {formatCountryLabel(entry.country, entry.description)}
            </span>
          </div>
          <RateComparison
            before={entry}
            after={next}
            unit={unit}
            locale={locale}
          />
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
              ? t('rates:edit.scheduledNote', {
                  rate: formatRate(entry.rate, {
                    currency: tenant.currency,
                    unit: true,
                    locale,
                  }),
                })
              : t('rates:edit.immediateNote')}
          </p>
          {generalError ? (
            <div className="flex flex-col gap-2">
              <ProblemAlert
                error={generalError}
                networkMessage={t('rates:edit.networkMessage')}
                onRefresh={() => {
                  void invalidateTenant(queryClient, tenant.id);
                  onClose();
                }}
              />
              {versionConflict && hasScheduled ? (
                <span className="text-xs leading-normal text-muted-foreground">
                  {t('rates:edit.scheduledConflict')}
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
              {t('rates:edit.back')}
            </Button>
            <Button
              className="h-12 md:h-9"
              disabled={edit.isPending}
              onClick={() => void submit()}
            >
              {t('rates:edit.confirm')}
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
  locale,
}: {
  before: AdminRateEntry;
  after: AdminRateEntry;
  unit: string;
  locale: Locale;
}) {
  const { t } = useTranslation(['rates', 'common', 'format']);
  const percent = rateChangePercent(before.rate, after.rate);
  const fieldLabels = {
    iso: t('rates:field.iso'),
    prefix: t('rates:field.prefix'),
    country: t('rates:field.country'),
    description: t('rates:field.description'),
  } as const satisfies Record<
    'iso' | 'prefix' | 'country' | 'description',
    string
  >;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-center gap-4 rounded-[10px] border border-border p-[18px] tabular-nums">
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {t('rates:edit.oldRate')}
          </span>
          <span className="text-[22px] text-muted-foreground line-through">
            {formatRate(before.rate, { locale })}
          </span>
        </div>
        <span aria-hidden className="text-xl text-muted-foreground">
          →
        </span>
        <div className="flex flex-col items-center gap-1">
          <span className="text-xs text-muted-foreground">
            {t('rates:edit.newRate')}
          </span>
          <span className="text-[26px] font-bold">
            {formatRate(after.rate, { locale })}
          </span>
        </div>
        {percent ? (
          <Badge
            variant={percent.rising ? 'error' : 'ok'}
            className="h-[26px] px-2.5 text-[13px] font-semibold"
          >
            {percent.rising ? t('rates:edit.rise') : t('rates:edit.fall')}{' '}
            {percent.text}
          </Badge>
        ) : null}
      </div>
      <span className="text-center text-xs text-muted-foreground">
        {t('rates:edit.unit', { unit })}
      </span>
      {rateEntryFields.map(({ key }) =>
        after[key] !== before[key] ? (
          <span key={key} className="text-[13px]">
            {fieldLabels[key]}：
            <span className="text-muted-foreground line-through">
              {blankAsDash(before[key])}
            </span>{' '}
            → <span className="font-semibold">{blankAsDash(after[key])}</span>
          </span>
        ) : null,
      )}
    </div>
  );
}

/** 生效时间：立即，或北京时间分钟（单条编辑与整表导入共用）。 */
export function ScheduleField({
  choice,
  error,
  disabled,
  descriptions,
  onChange,
}: {
  choice: ScheduleChoice;
  error: string | undefined;
  disabled: boolean;
  /** 选项下的说明（导入稿 1a），省略时只显示选项名。 */
  descriptions?: Record<ScheduleChoice['kind'], string>;
  onChange: (choice: ScheduleChoice) => void;
}) {
  const id = useId();
  const [minute, setMinute] = useState(
    choice.kind === 'scheduled' ? choice.minute : '',
  );
  const [bounds] = useState(() =>
    scheduleBounds(Date.now(), DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS),
  );
  const { t } = useTranslation(['rates', 'common', 'format']);
  const options = [
    { kind: 'immediate', label: t('rates:schedule.immediate') },
    { kind: 'scheduled', label: t('rates:schedule.scheduled') },
  ] as const;
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0 text-sm font-medium">
      <legend className="mb-2 p-0">{t('rates:schedule.label')}</legend>
      <RadioGroup
        aria-label={t('rates:schedule.label')}
        value={choice.kind}
        disabled={disabled}
        onValueChange={(kind) =>
          onChange(
            kind === 'immediate'
              ? { kind: 'immediate' }
              : { kind: 'scheduled', minute },
          )
        }
        className="grid-cols-2 gap-2 font-normal"
      >
        {options.map((option) => (
          <label
            key={option.kind}
            className={cn(
              'flex cursor-pointer gap-2.5 rounded-lg border border-input px-3 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-brand-soft',
              descriptions
                ? 'items-start py-2.5'
                : 'h-11 items-center has-[[data-state=checked]]:font-medium has-[[data-state=checked]]:text-primary md:h-10',
            )}
          >
            <RadioGroupItem
              value={option.kind}
              {...(descriptions
                ? {
                    'aria-label': option.label,
                    'aria-describedby': `${id}-${option.kind}`,
                  }
                : {})}
              className={cn(descriptions && 'mt-0.5')}
            />
            {descriptions ? (
              <span className="flex flex-col gap-0.5">
                <span className="font-medium">{option.label}</span>
                <span
                  id={`${id}-${option.kind}`}
                  className="text-xs text-muted-foreground"
                >
                  {descriptions[option.kind]}
                </span>
              </span>
            ) : (
              option.label
            )}
          </label>
        ))}
      </RadioGroup>
      {choice.kind === 'scheduled' ? (
        <Field label={t('rates:schedule.pickLabel')} error={error}>
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
