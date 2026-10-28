import { cn } from '@/lib/utils';

/** shadcn/ui Skeleton，底色用项目的 `--skeleton` 令牌。 */
function Skeleton({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="skeleton"
      className={cn('animate-pulse rounded-md bg-skeleton', className)}
      {...props}
    />
  );
}

export { Skeleton };
