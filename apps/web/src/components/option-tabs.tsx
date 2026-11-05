import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';

/** 选项值为 undefined 时（如“全部”），在 Tabs 里用这个值表示。 */
const emptyValue = 'all';

/**
 * 分段单选：用 shadcn Tabs 的外观，没有对应的内容面板，所以去掉 aria-controls。
 * 这里只负责 undefined 选项；手机上加高到 44px，便于触控。
 */
export function OptionTabs<Value extends string | undefined>({
  label,
  options,
  value,
  onChange,
  disabled,
  className,
}: {
  label: string;
  options: readonly { value: Value; label: string }[];
  value: Value;
  onChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <Tabs
      value={value ?? emptyValue}
      onValueChange={(next) => {
        const option = options.find(
          (item) => (item.value ?? emptyValue) === next,
        );
        if (option) onChange(option.value);
      }}
      className="contents"
    >
      <TabsList aria-label={label} className={cn('max-md:h-11!', className)}>
        {options.map((option) => (
          <TabsTrigger
            key={option.value ?? emptyValue}
            value={option.value ?? emptyValue}
            aria-controls={undefined}
            {...(disabled ? { disabled } : {})}
          >
            {option.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
