import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * 手机顶栏 40px 方形按钮（菜单、返回、关闭、更多、新增、导出）。
 * 默认描边；主操作（新增）传 `variant="default"`。作为链接时用 `asChild`。
 */
export function MobileBarButton({
  className,
  variant = 'outline',
  ...props
}: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant={variant}
      size="icon"
      className={cn('size-10 shrink-0', className)}
      {...props}
    />
  );
}
