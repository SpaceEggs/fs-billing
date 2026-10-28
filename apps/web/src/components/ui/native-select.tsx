import * as React from 'react';
import { ChevronDownIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui NativeSelect：保留浏览器原生下拉（手机上是系统选择器），箭头换成 lucide。
 * `className` 作用在 `<select>`；`containerClassName` 作用在外层，用来定宽与布局。
 */
function NativeSelect({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<'select'> & { containerClassName?: string }) {
  return (
    <div
      className={cn(
        'group/native-select relative inline-flex h-11 md:h-9',
        containerClassName,
      )}
      data-slot="native-select-wrapper"
    >
      <select
        data-slot="native-select"
        className={cn(
          'h-full w-full min-w-0 appearance-none rounded-lg border border-input bg-background pr-8 pl-3 text-base text-foreground outline-none selection:bg-primary selection:text-primary-foreground disabled:cursor-not-allowed disabled:bg-muted md:text-sm',
          'focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
          className,
        )}
        {...props}
      />
      <ChevronDownIcon
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground select-none"
        aria-hidden="true"
        data-slot="native-select-icon"
      />
    </div>
  );
}

function NativeSelectOption({
  className,
  ...props
}: React.ComponentProps<'option'>) {
  return (
    <option
      data-slot="native-select-option"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

function NativeSelectOptGroup({
  className,
  ...props
}: React.ComponentProps<'optgroup'>) {
  return (
    <optgroup
      data-slot="native-select-optgroup"
      className={cn('bg-[Canvas] text-[CanvasText]', className)}
      {...props}
    />
  );
}

export { NativeSelect, NativeSelectOptGroup, NativeSelectOption };
