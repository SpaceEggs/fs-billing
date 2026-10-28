import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

/**
 * shadcn/ui Alert，在默认与 destructive 之外按项目的状态令牌加了 error / warning / success / unverified / brand / muted。
 * 没有图标时是纵向排列的盒子，内容可以是任意子元素；
 * 带 lucide 图标时（直接子元素 svg）图标占第一列，标题与说明在第二列，`AlertAction` 在第三列。
 */
const alertVariants = cva(
  'relative flex w-full flex-col gap-0.5 rounded-lg border px-3 py-2.5 text-[13px] leading-normal has-[>svg]:grid has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr] has-[>svg]:items-start has-[>svg]:gap-x-2.5 [&>svg]:size-4 [&>svg]:translate-y-px [&>svg]:text-current',
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
        unverified:
          'border-unv-border bg-unv-soft text-unv *:data-[slot=alert-description]:text-unv',
        brand:
          'border-brand-border bg-brand-soft text-foreground *:data-[slot=alert-description]:text-foreground',
        muted:
          'border-off-border bg-off-soft text-foreground *:data-[slot=alert-description]:text-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

/** 错误提示默认是 `alert`，成功提示默认是状态播报 `status`，其余不带角色；需要时用 `role` 指定（静态说明用 `note`）。 */
function Alert({
  className,
  variant,
  role,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof alertVariants>) {
  const defaultRole =
    variant === 'error' || variant === 'destructive'
      ? 'alert'
      : variant === 'success'
        ? 'status'
        : undefined;
  return (
    <div
      data-slot="alert"
      role={role ?? defaultRole}
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
        'col-start-2 text-muted-foreground [&_p]:leading-relaxed',
        className,
      )}
      {...props}
    />
  );
}

/** 右侧的操作按钮（重试、刷新）；外层用 `has-[>svg]:grid-cols-[1rem_1fr_auto]` 腾出第三列。 */
function AlertAction({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="alert-action"
      className={cn('col-start-3 row-start-1 row-span-2 self-start', className)}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription, AlertAction };
