import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import {
  monthCells,
  monthOf,
  orderedRange,
  shiftMonth,
  type DayRange,
} from '../lib/day-range';
import { formatDay, formatDayRange, formatYearMonth } from '../lib/format';
import { useLocale } from '../i18n';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ModalDialog } from './modal-dialog';

const weekdayKeys = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

/**
 * 设计系统 · 日期范围：一个显示「开始 — 结束」的输入框，点开为月历（客户门户第一批 2f）。
 * 第一次点选开始日，第二次点选结束日（早于开始日时两者互换），确定后才回调。晚于 `max` 的日期不可选。
 */
export function DateRangeField({
  label,
  value,
  max,
  maxRangeEndForStart,
  onChange,
  className,
}: {
  label: string;
  value: DayRange;
  max: string;
  /** Optional maximum inclusive end date for a range beginning on the given day. */
  maxRangeEndForStart?: (from: string) => string;
  onChange: (range: DayRange) => void;
  className?: string;
}) {
  const { t } = useTranslation(['common']);
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        aria-haspopup="dialog"
        aria-label={t('dateRange.value', {
          label,
          from: formatDay(value.from, locale),
          to: formatDay(value.to, locale),
        })}
        onClick={() => setOpen(true)}
        className={cn(
          'h-11 justify-between gap-2.5 px-3 font-normal tabular-nums md:h-9',
          className,
        )}
      >
        <span className="md:hidden">{formatDayRange(value, true, locale)}</span>
        <span className="hidden md:inline">
          {formatDayRange(value, false, locale)}
        </span>
        <CalendarDaysIcon
          aria-hidden
          className="hidden size-3.5 text-muted-foreground md:inline"
        />
      </Button>
      {open ? (
        <RangeCalendar
          label={label}
          initial={value}
          max={max}
          {...(maxRangeEndForStart ? { maxRangeEndForStart } : {})}
          onClose={() => setOpen(false)}
          onConfirm={(range) => {
            setOpen(false);
            onChange(range);
          }}
        />
      ) : null}
    </>
  );
}

/** 已选开始日、尚未选结束日时 `to` 为 null。 */
type Draft = { from: string; to: string | null };

function RangeCalendar({
  label,
  initial,
  max,
  maxRangeEndForStart,
  onClose,
  onConfirm,
}: {
  label: string;
  initial: DayRange;
  max: string;
  maxRangeEndForStart?: (from: string) => string;
  onClose: () => void;
  onConfirm: (range: DayRange) => void;
}) {
  const { t } = useTranslation(['common']);
  const locale = useLocale();
  const [draft, setDraft] = useState<Draft>(initial);
  const [view, setView] = useState(() => monthOf(initial.to));
  const lastMonth = monthOf(max);
  const atLastMonth =
    view.year * 12 + view.month >= lastMonth.year * 12 + lastMonth.month;
  const pick = (day: string) =>
    setDraft((current) =>
      current.to === null
        ? orderedRange(current.from, day)
        : { from: day, to: null },
    );
  const { to } = draft;
  const completeRange = to === null ? null : orderedRange(draft.from, to);
  const rangeIsAllowed = (range: DayRange) =>
    maxRangeEndForStart === undefined ||
    range.to <= maxRangeEndForStart(range.from);
  const endLimit =
    maxRangeEndForStart === undefined
      ? undefined
      : maxRangeEndForStart(completeRange?.from ?? draft.from);
  const exceedsRangeLimit =
    completeRange !== null && !rangeIsAllowed(completeRange);
  return (
    <ModalDialog
      open
      onOpenChange={(next) => next || onClose()}
      title={label}
      className="gap-3.5 md:w-[360px]"
    >
      <div className="mr-9 flex h-11 items-center justify-between md:h-9">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('dateRange.previousMonth')}
          onClick={() => setView((month) => shiftMonth(month, -1))}
          className="rounded-md text-muted-foreground"
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span aria-live="polite" className="text-base font-semibold">
          {formatYearMonth(view.year, view.month, locale)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('dateRange.nextMonth')}
          disabled={atLastMonth}
          onClick={() => setView((month) => shiftMonth(month, 1))}
          className="rounded-md text-muted-foreground disabled:opacity-40"
        >
          <ChevronRightIcon aria-hidden />
        </Button>
      </div>
      <div
        aria-hidden
        className="grid grid-cols-7 text-center text-xs text-muted-foreground"
      >
        {weekdayKeys.map((day) => (
          <span key={day}>{t(`weekday.${day}` as 'weekday.mon')}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[15px] tabular-nums md:text-sm">
        {monthCells(view).map((day, index) => {
          if (day === null) return <span key={`blank-${index}`} />;
          const exceedsPendingRangeLimit =
            to === null &&
            maxRangeEndForStart !== undefined &&
            !rangeIsAllowed(orderedRange(draft.from, day));
          const start = day === draft.from;
          const end = day === (to ?? draft.from);
          const inside = to !== null && day > draft.from && day < to;
          return (
            <button
              key={day}
              type="button"
              aria-label={formatDay(day, locale)}
              aria-pressed={start || end || inside}
              disabled={day > max || exceedsPendingRangeLimit}
              onClick={() => pick(day)}
              className={cn(
                'h-11 outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:text-muted-foreground md:h-9',
                inside && 'bg-muted',
                (start || end) &&
                  'bg-primary font-semibold text-primary-foreground',
                start && 'rounded-l-lg',
                end && 'rounded-r-lg',
                !start && !end && !inside && 'rounded-lg hover:bg-muted',
              )}
            >
              {Number(day.slice(8))}
            </button>
          );
        })}
      </div>
      <div
        aria-live="polite"
        className="flex justify-between rounded-lg bg-muted px-3 py-2.5 text-[13px] text-muted-foreground tabular-nums"
      >
        {to === null ? (
          <span>
            {formatDay(draft.from, locale)} — {t('dateRange.selectEnd')}
          </span>
        ) : (
          <span>
            {formatDayRange(
              completeRange ?? { from: draft.from, to },
              false,
              locale,
            )}
          </span>
        )}
        <span>
          {maxRangeEndForStart === undefined
            ? t('timezone.beijing')
            : t('timezone.rangeLimited')}
        </span>
      </div>
      {maxRangeEndForStart !== undefined &&
      endLimit !== undefined &&
      (to === null || exceedsRangeLimit) ? (
        <p
          role={exceedsRangeLimit ? 'alert' : 'status'}
          className={cn(
            'm-0 text-[13px]',
            exceedsRangeLimit ? 'text-err' : 'text-muted-foreground',
          )}
        >
          {to === null
            ? t('dateRange.endLimitPending', {
                date: formatDay(endLimit, locale),
              })
            : t('dateRange.endLimit', {
                date: formatDay(endLimit, locale),
              })}
        </p>
      ) : null}
      <div className="grid grid-cols-[1fr_2fr] gap-2 md:flex md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
          {t('action.cancel')}
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={to === null || to > max || exceedsRangeLimit}
          onClick={() => {
            if (
              to !== null &&
              completeRange !== null &&
              to <= max &&
              !exceedsRangeLimit
            )
              onConfirm(completeRange);
          }}
        >
          {t('action.confirm')}
        </Button>
      </div>
    </ModalDialog>
  );
}
