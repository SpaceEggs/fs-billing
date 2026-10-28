import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Alert，在默认与 destructive 之外按项目的状态令牌加了 error / warning / success。
 * 带 lucide 图标时（直接子元素 svg）图标占第一列，标题与说明在第二列。
 */
const alertVariants = cva(
  'relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-lg border px-3 py-2.5 text-[13px] leading-normal has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-px [&>svg]:text-current',
  {
    variants: {
      variant: {
        default: 'bg-card text-card-foreground',
        destructive:
          'border-alert-neg-border bg-alert-neg-soft text-alert-neg *:data-[slot=alert-description]:text-alert-neg',
        error:
          'border-err-border bg-err-soft text-err *:data-[slot=alert-description]:text-err',
        warning:
          'border-warn-border bg-warn-soft text-warn *:data-[slot=alert-description]:text-warn',
        success:
          'border-ok-border bg-ok-soft text-ok *:data-[slot=alert-description]:text-ok',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/** 成功提示是状态播报（`status`），其余是 `alert`；需要时可用 `role` 覆盖。 */
function Alert({
  className,
  variant,
  role,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={role ?? (variant === 'success' ? 'status' : 'alert')}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-title"
      className={cn('col-start-2 min-h-4 font-semibold', className)}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        'col-start-2 grid justify-items-start gap-0.5 text-muted-foreground [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };
