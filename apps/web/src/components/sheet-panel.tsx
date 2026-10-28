import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

/** 手机底部弹出面板与侧边抽屉，建在 shadcn 的 Sheet 上；标题只给读屏软件，关闭靠遮罩与 Esc。 */
export function SheetPanel({
  side,
  title,
  trigger,
  children,
  open,
  onOpenChange,
}: {
  side: 'bottom' | 'left';
  title: string;
  trigger?: React.ReactNode;
  children: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Sheet
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent
        side={side}
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          'text-foreground shadow-none',
          side === 'bottom'
            ? 'h-auto gap-1 rounded-t-2xl border-t-0 bg-card px-4 pt-2 pb-7 text-base'
            : 'w-[300px] gap-5 border-r-0 bg-side px-3 pt-14 pb-6 sm:max-w-none',
        )}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {side === 'bottom' ? (
          <div
            aria-hidden
            className="mb-2 h-1 w-9 self-center rounded-sm bg-input"
          />
        ) : null}
        {children}
      </SheetContent>
    </Sheet>
  );
}
