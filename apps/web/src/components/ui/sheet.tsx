import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';

/** 手机底部弹出面板与侧边抽屉。 */
export function Sheet({
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
    <Dialog.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      {trigger ? <Dialog.Trigger asChild>{trigger}</Dialog.Trigger> : null}
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          aria-describedby={undefined}
          className={cn(
            'fixed z-50 flex flex-col text-foreground outline-none',
            side === 'bottom'
              ? 'inset-x-0 bottom-0 gap-1 rounded-t-2xl bg-card px-4 pt-2 pb-7 text-base'
              : 'inset-y-0 left-0 w-[300px] gap-5 bg-side px-3 pt-14 pb-6',
          )}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {side === 'bottom' ? (
            <div
              aria-hidden
              className="mb-2 h-1 w-9 self-center rounded-sm bg-input"
            />
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
