import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';

/** 每个打开的对话框对应的打开者，供从对话框里接着打开的对话框（下一步、操作菜单）沿用。 */
const openers = new WeakMap<Element, HTMLElement>();

function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const host = active.closest('[role="dialog"]');
  return host ? (openers.get(host) ?? null) : active;
}

/**
 * 电脑居中、手机底部弹出的对话框。Radix 负责焦点进入与焦点圈定；
 * 没有 Dialog.Trigger，关闭（含卸载）后由这里把焦点还给打开时聚焦的元素。
 * `onOpenChange` 省略时不可通过 Esc 或点击遮罩关闭（例如只显示一次的密码）。
 * `returnFocus` 指向关闭时已挂载的元素（例如成功提示）时优先聚焦它，用于打开者随操作消失的情形；
 * 两者都不可聚焦（已卸载或已禁用）时聚焦 `fallbackFocus`（例如页面上的列表区域），焦点不落到 body。
 */
export function ModalDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  returnFocus,
  fallbackFocus,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  returnFocus?: React.RefObject<HTMLElement | null>;
  fallbackFocus?: React.RefObject<HTMLElement | null>;
}) {
  const dismissible = onOpenChange !== undefined;
  // 每次打开时（首次挂载即打开，或 open 由 false 变 true）在渲染中记下打开者，此时焦点尚未移入对话框。
  const [opener, setOpener] = useState(() => (open ? currentOpener() : null));
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpener(currentOpener());
  }
  return (
    <Dialog.Root open={open} {...(onOpenChange ? { onOpenChange } : {})}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim" />
        <Dialog.Content
          ref={(node) => {
            if (node && opener) openers.set(node, opener);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = [
              returnFocus?.current,
              opener,
              fallbackFocus?.current,
            ].find(
              (element) =>
                element?.isConnected && !element.matches(':disabled'),
            );
            // 换成下一步对话框时焦点留在新对话框里。
            if (target && !document.querySelector('[role="dialog"]'))
              target.focus();
          }}
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
