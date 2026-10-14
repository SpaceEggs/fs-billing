import type { InputHTMLAttributes } from 'react';
import { cn } from '../../lib/utils';

export function Input({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full min-w-0 rounded-lg border border-input bg-transparent px-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:bg-muted sm:h-10 sm:text-sm',
        className,
      )}
      {...props}
    />
  );
}
