import { Toggle } from '@/components/ui/toggle';
import { cn } from '@/lib/utils';

/**
 * 分段选择（币种、待收款状态），每段是 shadcn 的 Toggle（aria-pressed 按钮）；
 * `value` 为 undefined 表示「全部」。
 */
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
          <Toggle
            key={option.value ?? 'all'}
            pressed={selected}
            // 已选中的一段再次点击不取消选择。
            onPressedChange={() => onChange(option.value)}
            className={cn(
              'h-auto flex-1 rounded-md px-3 text-[13px] font-normal hover:bg-transparent md:flex-none',
              selected
                ? 'bg-background font-medium text-foreground shadow-[0_1px_2px_rgba(0,0,0,.1)] data-[state=on]:bg-background data-[state=on]:text-foreground hover:bg-background hover:text-foreground'
                : 'text-muted-foreground hover:text-muted-foreground',
            )}
          >
            {option.label}
          </Toggle>
        );
      })}
    </div>
  );
}
