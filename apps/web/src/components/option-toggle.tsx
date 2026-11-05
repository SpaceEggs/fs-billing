import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/** 选项值为 undefined 时（如“全部”），在 ToggleGroup 里用这个值表示。 */
const emptyValue = 'all';

/**
 * 单选筛选项：shadcn ToggleGroup 的薄封装，负责 undefined 选项和“再次点击不取消”。
 * 手机上按钮加高到 44px，便于触控。
 */
export function OptionToggle<Value extends string | undefined>({
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
    <ToggleGroup
      type="single"
      aria-label={label}
      variant="outline"
      value={value ?? emptyValue}
      onValueChange={(next) => {
        const option = options.find(
          (item) => (item.value ?? emptyValue) === next,
        );
        if (option) onChange(option.value);
      }}
      className={cn('max-md:[&>button]:h-11', className)}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value ?? emptyValue}
          value={option.value ?? emptyValue}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
