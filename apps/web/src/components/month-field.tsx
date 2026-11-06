import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from 'lucide-react';
import { translate, type Locale } from '@fs-billing/shared';
import { shiftStatementMonth } from '../lib/admin-statements';
import { statementMonthTitle } from '../lib/statement';
import { formatYear, monthName } from '../lib/format';
import { useLocale } from '../i18n';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ModalDialog } from './modal-dialog';

const step =
  'shrink-0 text-muted-foreground disabled:opacity-40 max-md:size-11';

/**
 * 月份选择（运营稿 5a/5c：‹ 2026年8月 ▾ ›）：两侧按钮前后翻一个月，中间点开 12 个月的网格并可翻年。
 * 早于 `min` 或晚于 `max` 的月份不可选；翻到 `max` 时「›」置灰。月份格式 YYYY-MM。
 */
export function MonthField({
  label,
  value,
  min,
  max,
  onChange,
  className,
  showLabel = false,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  onChange: (month: string) => void;
  className?: string;
  /** 在控件上方显示小标签（运营稿 5a 电脑）；手机稿 5c 没有标签。读屏名称不受影响。 */
  showLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(value.slice(0, 4)));
  const { t } = useTranslation(['common']);
  const locale = useLocale();
  const openGrid = () => {
    setYear(Number(value.slice(0, 4)));
    setOpen(true);
  };
  const row = (
    <div className={cn('flex items-center gap-1', className)}>
      <Button
        variant="outline"
        size="icon"
        aria-label={t('monthField.previousMonth', { label })}
        disabled={value <= min}
        onClick={() => onChange(shiftStatementMonth(value, -1))}
        className={step}
      >
        <ChevronLeftIcon aria-hidden />
      </Button>
      <Button
        variant="outline"
        aria-haspopup="dialog"
        aria-label={t('monthField.value', {
          label,
          month: statementMonthTitle(value, locale),
        })}
        onClick={openGrid}
        className="min-w-0 justify-between gap-6 px-3 font-normal max-md:h-11 max-md:flex-1 max-md:justify-center max-md:text-[15px]"
      >
        {statementMonthTitle(value, locale)}
        <ChevronDownIcon
          aria-hidden
          className="size-3.5 text-muted-foreground"
        />
      </Button>
      <Button
        variant="outline"
        size="icon"
        aria-label={t('monthField.nextMonth', { label })}
        disabled={value >= max}
        onClick={() => onChange(shiftStatementMonth(value, 1))}
        className={step}
      >
        <ChevronRightIcon aria-hidden />
      </Button>
      {open ? (
        <ModalDialog
          open
          onOpenChange={(next) => next || setOpen(false)}
          title={label}
          className="gap-3.5 md:w-[340px]"
        >
          <MonthGrid
            year={year}
            minYear={Number(min.slice(0, 4))}
            maxYear={Number(max.slice(0, 4))}
            onYearChange={setYear}
            value={value}
            onPick={(month) => {
              setOpen(false);
              onChange(month);
            }}
            cell={(month) => ({ disabled: month < min || month > max })}
            // 关闭按钮盖在年份行右上角；删除话单的网格不在这一角，不传。
            yearRowClassName="mr-9"
          />
          <div className="flex justify-end">
            <Button
              variant="outline"
              className="h-12 md:h-9"
              onClick={() => setOpen(false)}
            >
              {t('action.cancel')}
            </Button>
          </div>
        </ModalDialog>
      ) : null}
    </div>
  );
  return showLabel ? (
    <div className="flex flex-col gap-1.5">
      <span aria-hidden className="text-xs text-muted-foreground">
        {label}
      </span>
      {row}
    </div>
  ) : (
    row
  );
}

/** 删除话单月份格（月份可选规则）。账单页的月份选择只使用 `disabled`。 */
export type MonthCellState = {
  readonly disabled: boolean;
  /** 月份下方的小字，例如「9,642 条」「已删除」「账单未生成」。 */
  readonly sub?: string;
  /** 不可选原因，悬停提示，例如「本月账单尚未生成，不可选」。 */
  readonly title?: string;
};

function monthCellName(month: string, state: MonthCellState, locale: Locale) {
  const label = statementMonthTitle(month, locale);
  const extra = [state.sub, state.title].filter(
    (part): part is string => !!part,
  );
  return extra.length === 0
    ? label
    : [label, ...extra].join(translate(locale, 'common:listComma'));
}

/**
 * 一年 12 个月的网格和翻年。账单页把它包在对话框里；删除话单把它嵌在自己的对话框里，
 * 每格的可选、小字和原因由 `cell` 给出（按 `YYYY-MM`）。
 */
export function MonthGrid({
  year,
  minYear,
  maxYear,
  onYearChange,
  value,
  onPick,
  cell,
  yearRowClassName,
  columnsClassName = 'grid-cols-4',
}: {
  year: number;
  minYear: number;
  maxYear: number;
  onYearChange: (year: number) => void;
  /** 选中的 YYYY-MM。没有选中时为 null。 */
  value: string | null;
  onPick: (month: string) => void;
  cell: (month: string) => MonthCellState;
  /** 年份行的额外类。账单页用它躲开对话框的关闭按钮。 */
  yearRowClassName?: string;
  /** 月份格的列数类。默认四列（账单页）；删除话单手机稿三列，传 `grid-cols-3 md:grid-cols-4`。 */
  columnsClassName?: string;
}) {
  const { t } = useTranslation(['common']);
  const locale = useLocale();
  const key = (month: number) => `${year}-${String(month).padStart(2, '0')}`;
  return (
    <>
      <div
        className={cn(
          'flex h-11 items-center justify-between md:h-9',
          yearRowClassName,
        )}
      >
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('monthField.previousYear')}
          disabled={year <= minYear}
          onClick={() => onYearChange(year - 1)}
          className="rounded-md text-muted-foreground disabled:opacity-40"
        >
          <ChevronLeftIcon aria-hidden />
        </Button>
        <span aria-live="polite" className="text-base font-semibold">
          {formatYear(year, locale)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('monthField.nextYear')}
          disabled={year >= maxYear}
          onClick={() => onYearChange(year + 1)}
          className="rounded-md text-muted-foreground disabled:opacity-40"
        >
          <ChevronRightIcon aria-hidden />
        </Button>
      </div>
      <div className={cn('grid gap-1.5', columnsClassName)}>
        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => {
          const monthKey = key(month);
          const state = cell(monthKey);
          const selected = monthKey === value;
          const sub = state.sub || undefined;
          return (
            <button
              key={month}
              type="button"
              aria-label={monthCellName(monthKey, state, locale)}
              aria-pressed={selected}
              disabled={state.disabled}
              {...(state.title ? { title: state.title } : {})}
              onClick={() => onPick(monthKey)}
              className={cn(
                'h-11 rounded-lg text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:text-muted-foreground disabled:opacity-40 md:h-10 md:text-sm',
                sub && 'flex flex-col items-center justify-center gap-px',
                selected
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {monthName(month, locale)}
              {sub ? (
                <span className="text-[10px] font-normal leading-none">
                  {sub}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
