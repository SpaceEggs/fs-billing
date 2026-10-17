import { useState } from 'react';
import {
  monthCells,
  monthOf,
  orderedRange,
  rangeLabel,
  shiftMonth,
  type DayRange,
} from '../lib/day-range';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { ModalDialog } from './ui/dialog';

const weekdays = ['一', '二', '三', '四', '五', '六', '日'];

/**
 * 设计系统 · 日期范围：一个显示「开始 — 结束」的输入框，点开为月历（客户门户第一批 2f）。
 * 第一次点选开始日，第二次点选结束日（早于开始日时两者互换），确定后才回调。晚于 `max` 的日期不可选。
 */
export function DateRangeField({
  label,
  value,
  max,
  onChange,
  className,
}: {
  label: string;
  value: DayRange;
  max: string;
  onChange: (range: DayRange) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-label={`${label}：${value.from} 至 ${value.to}`}
        onClick={() => setOpen(true)}
        className={cn(
          'flex h-11 items-center justify-between gap-2.5 rounded-lg border border-input px-3 text-sm tabular-nums outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:h-9',
          className,
        )}
      >
        <span className="md:hidden">{rangeLabel(value, true)}</span>
        <span className="hidden md:inline">{rangeLabel(value)}</span>
        <span
          aria-hidden
          className="hidden text-xs text-muted-foreground md:inline"
        >
          ▦
        </span>
      </button>
      {open ? (
        <RangeCalendar
          label={label}
          initial={value}
          max={max}
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
  onClose,
  onConfirm,
}: {
  label: string;
  initial: DayRange;
  max: string;
  onClose: () => void;
  onConfirm: (range: DayRange) => void;
}) {
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
  return (
    <ModalDialog
      open
      onOpenChange={(next) => next || onClose()}
      title={label}
      className="gap-3.5 md:w-[360px]"
    >
      <div className="mr-9 flex h-11 items-center justify-between md:h-9">
        <button
          type="button"
          aria-label="上个月"
          onClick={() => setView((month) => shiftMonth(month, -1))}
          className="flex size-9 items-center justify-center rounded-md text-[15px] text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          ‹
        </button>
        <span aria-live="polite" className="text-base font-semibold">
          {view.year}年{view.month}月
        </span>
        <button
          type="button"
          aria-label="下个月"
          disabled={atLastMonth}
          onClick={() => setView((month) => shiftMonth(month, 1))}
          className="flex size-9 items-center justify-center rounded-md text-[15px] text-muted-foreground outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-40"
        >
          ›
        </button>
      </div>
      <div
        aria-hidden
        className="grid grid-cols-7 text-center text-xs text-muted-foreground"
      >
        {weekdays.map((day) => (
          <span key={day}>{day}</span>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-1 text-center text-[15px] tabular-nums md:text-sm">
        {monthCells(view).map((day, index) => {
          if (day === null) return <span key={`blank-${index}`} />;
          const start = day === draft.from;
          const end = day === (to ?? draft.from);
          const inside = to !== null && day > draft.from && day < to;
          return (
            <button
              key={day}
              type="button"
              aria-label={day}
              aria-pressed={start || end || inside}
              disabled={day > max}
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
          <span>{draft.from} — 请选择结束日期</span>
        ) : (
          <span>{rangeLabel({ from: draft.from, to })}</span>
        )}
        <span>北京时间</span>
      </div>
      <div className="grid grid-cols-[1fr_2fr] gap-2 md:flex md:justify-end">
        <Button variant="outline" className="h-12 md:h-9" onClick={onClose}>
          取消
        </Button>
        <Button
          className="h-12 md:h-9"
          disabled={to === null}
          onClick={() => {
            if (to !== null) onConfirm({ from: draft.from, to });
          }}
        >
          确定
        </Button>
      </div>
    </ModalDialog>
  );
}
