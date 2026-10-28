import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Button，外观沿用项目令牌：
 * - `destructive` 是描边加红字（后台的危险操作），不是实心红；
 * - `field` 为表单内与输入框等高的按钮（手机 44px、电脑 40px）。
 */
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-lg font-medium whitespace-nowrap transition-[opacity,background-color] outline-none focus-visible:ring-[3px] focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:opacity-90',
        destructive:
          'border border-input bg-transparent text-neg hover:bg-muted',
        outline:
          'border border-input bg-transparent text-foreground hover:bg-muted',
        secondary: 'bg-secondary text-secondary-foreground hover:opacity-80',
        ghost: 'bg-transparent text-foreground hover:bg-muted',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 text-sm',
        sm: 'h-8 px-3 text-[13px]',
        field: 'h-11 px-4 text-base sm:h-10 sm:text-sm',
        lg: 'h-11 px-4 text-base',
        icon: 'size-9 text-[15px]',
        // 文字链接式按钮：不设高度、内边距与字号，随周围文字。
        inline: 'h-auto gap-1 rounded-sm p-0 font-normal',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

/** 未指定 `type` 时为 `button`，避免在表单里意外提交；`asChild` 时由子元素决定。 */
function Button({
  className,
  variant = 'default',
  size = 'default',
  asChild = false,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      {...(asChild ? {} : { type })}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
