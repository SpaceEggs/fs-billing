import { cn } from '../../lib/utils';

/** 分段选择（币种、待收款状态）：每段是 aria-pressed 按钮，`value` 为 undefined 表示「全部」。 */
export function Segmented<Value extends string | undefined>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex h-11 gap-0.5 self-start rounded-lg bg-muted p-[3px] text-[13px] md:h-9',
        className,
      )}
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
              'flex-1 rounded-md px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring md:flex-none',
              selected
                ? 'bg-background font-medium shadow-[0_1px_2px_rgba(0,0,0,.1)]'
                : 'text-muted-foreground',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
