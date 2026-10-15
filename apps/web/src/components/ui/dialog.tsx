import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';

/**
 * 电脑居中、手机底部弹出的对话框。Radix 负责焦点进入、焦点圈定与关闭后归还。
 * `onOpenChange` 省略时不可通过 Esc 或点击遮罩关闭（例如只显示一次的密码）。
 */
export function ModalDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const dismissible = onOpenChange !== undefined;
  return (
    <Dialog.Root open={open} {...(onOpenChange ? { onOpenChange } : {})}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          {...(description ? {} : { 'aria-describedby': undefined })}
          onEscapeKeyDown={
            dismissible ? undefined : (event) => event.preventDefault()
          }
          onPointerDownOutside={
            dismissible ? undefined : (event) => event.preventDefault()
          }
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col gap-4 overflow-y-auto rounded-t-2xl bg-card px-4 pt-2 pb-7 text-foreground outline-none md:inset-auto md:top-1/2 md:left-1/2 md:w-[520px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:p-6 md:shadow-[0_16px_48px_rgba(0,0,0,.25)]',
            className,
          )}
        >
          <div
            aria-hidden
            className="h-1 w-10 self-center rounded-sm bg-input md:hidden"
          />
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {description ? (
            <Dialog.Description className="sr-only">
              {description}
            </Dialog.Description>
          ) : null}
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
