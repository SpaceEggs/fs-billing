import type { SelectHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

/**
 * 原生下拉框，去掉浏览器箭头、改用设计稿的「▾」。`className` 作用在外层，用来定宽高与布局。
 */
export function Select({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={cn('relative inline-flex h-11 md:h-9', className)}>
      <select
        className="h-full w-full min-w-0 appearance-none rounded-lg border border-input bg-background pr-8 pl-3 text-base text-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:bg-muted md:text-sm"
        {...props}
      />
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted-foreground"
      >
        ▾
      </span>
    </span>
  );
}
