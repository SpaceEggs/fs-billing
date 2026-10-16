import { useId, useState } from 'react';
import { cn } from '../lib/utils';
import { Button } from './ui/button';
import { Sheet } from './ui/sheet';

/**
 * 手机版「筛选」按钮与底部面板（设计系统 · 手机筛选）：筛选即时写入地址，
 * 「清除筛选」只清面板里的条件，搜索框不受影响。电脑版筛选直接排在列表上方，不渲染这里。
 */
export function FilterSheet({
  activeCount,
  resultLabel,
  onClear,
  children,
}: {
  activeCount: number;
  resultLabel: string;
  onClear: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet
      side="bottom"
      title="筛选"
      open={open}
      onOpenChange={setOpen}
      trigger={
        <button
          type="button"
          aria-label={activeCount ? `筛选，已选 ${activeCount} 项` : '筛选'}
          className={cn(
            'flex h-11 shrink-0 items-center gap-1.5 rounded-lg border px-3.5 text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:hidden',
            activeCount ? 'border-primary bg-brand-soft' : 'border-input',
          )}
        >
          筛选
          {activeCount ? (
            <span
              aria-hidden
              className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold text-primary-foreground"
            >
              {activeCount}
            </span>
          ) : null}
        </button>
      }
    >
      <div className="flex items-center justify-between">
        <span aria-hidden className="text-[17px] font-semibold">
          筛选
        </span>
        <button
          type="button"
          disabled={activeCount === 0}
          onClick={onClear}
          className="h-11 text-[15px] text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:opacity-50"
        >
          清除筛选
        </button>
      </div>
      <div className="flex flex-col gap-[18px] pt-2 pb-5">{children}</div>
      <Button size="lg" className="h-12" onClick={() => setOpen(false)}>
        {resultLabel}
      </Button>
    </Sheet>
  );
}

/** 面板里的一组条件：可见标题即分组名。 */
export function FilterGroup({
  label,
  children,
}: {
  label: string;
  children: (labelId: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      {children(id)}
    </div>
  );
}

/** 面板里的多选一（如租户状态），三列按钮，aria-pressed 标出当前项。 */
export function ChoiceGrid<Value extends string | undefined>({
  labelledBy,
  options,
  value,
  onChange,
}: {
  labelledBy: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  return (
    <div
      role="group"
      aria-labelledby={labelledBy}
      className="grid grid-cols-3 gap-2"
    >
      {options.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value ?? 'all'}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              'h-11 rounded-lg border text-[15px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring',
              selected
                ? 'border-[1.5px] border-primary bg-brand-soft font-medium text-primary'
                : 'border-input',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** 面板里的结果按钮文字：结果未到时不显示上一次的数量。 */
export function resultLabel(total: number | undefined, unit: string) {
  return total === undefined ? '查看结果' : `查看 ${total} ${unit}结果`;
}
