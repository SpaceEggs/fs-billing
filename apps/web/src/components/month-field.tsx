import { useState } from 'react';
import { shiftStatementMonth } from '../lib/admin-statements';
import { statementMonthTitle } from '../lib/statement';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ModalDialog } from './ui/dialog';

const step =
  'flex size-9 shrink-0 items-center justify-center rounded-lg border border-input text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40 max-md:size-11';

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
  const row = (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        type="button"
        aria-label={`${label}：上个月`}
        disabled={value <= min}
        onClick={() => onChange(shiftStatementMonth(value, -1))}
        className={step}
      >
        ‹
      </button>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${label}：${statementMonthTitle(value)}`}
        onClick={() => setOpen(true)}
        className="flex h-9 min-w-0 items-center justify-between gap-6 rounded-lg border border-input px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 max-md:h-11 max-md:flex-1 max-md:justify-center max-md:text-[15px]"
      >
        {statementMonthTitle(value)}
        <span aria-hidden className="text-xs text-muted-foreground">
          ▾
        </span>
      </button>
      <button
        type="button"
        aria-label={`${label}：下个月`}
        disabled={value >= max}
        onClick={() => onChange(shiftStatementMonth(value, 1))}
        className={step}
      >
        ›
      </button>
      {open ? (
        <MonthGrid
          label={label}
          value={value}
          min={min}
          max={max}
          onClose={() => setOpen(false)}
          onPick={(month) => {
            setOpen(false);
            onChange(month);
          }}
        />
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

function MonthGrid({
  label,
  value,
  min,
  max,
  onClose,
  onPick,
}: {
  label: string;
  value: string;
  min: string;
  max: string;
  onClose: () => void;
  onPick: (month: string) => void;
}) {
  const [year, setYear] = useState(Number(value.slice(0, 4)));
  const key = (month: number) => `${year}-${String(month).padStart(2, '0')}`;
  return (
    <ModalDialog
      open
      onOpenChange={(next) => next || onClose()}
      title={label}
      className="gap-3.5 md:w-[340px]"
    >
      <div className="mr-9 flex h-11 items-center justify-between md:h-9">
        <button
          type="button"
          aria-label="上一年"
          disabled={key(1) <= min.slice(0, 4) + '-01'}
          onClick={() => setYear((current) => current - 1)}
          className="flex size-9 items-center justify-center rounded-md text-[15px] text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-40"
        >
          ‹
        </button>
        <span aria-live="polite" className="text-base font-semibold">
          {year}年
        </span>
        <button
          type="button"
          aria-label="下一年"
          disabled={year >= Number(max.slice(0, 4))}
          onClick={() => setYear((current) => current + 1)}
          className="flex size-9 items-center justify-center rounded-md text-[15px] text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-40"
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {Array.from({ length: 12 }, (_, index) => index + 1).map((month) => {
          const selected = key(month) === value;
          return (
            <button
              key={month}
              type="button"
              aria-label={statementMonthTitle(key(month))}
              aria-pressed={selected}
              disabled={key(month) < min || key(month) > max}
              onClick={() => onPick(key(month))}
              className={cn(
                'h-11 rounded-lg text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:text-muted-foreground disabled:opacity-40 md:h-10 md:text-sm',
                selected
                  ? 'bg-primary font-semibold text-primary-foreground'
                  : 'hover:bg-muted',
              )}
            >
              {month}月
            </button>
          );
        })}
      </div>
      <div className="flex justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
          取消
        </Button>
      </div>
    </ModalDialog>
  );
}
