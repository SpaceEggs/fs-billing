import { useState } from 'react';
import { XIcon } from 'lucide-react';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/** 每个打开的对话框对应的打开者，供从对话框里接着打开的对话框（下一步、操作菜单）沿用。 */
const openers = new WeakMap<Element, HTMLElement>();

function currentOpener(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;
  const host = active.closest('[role="dialog"]');
  return host ? (openers.get(host) ?? null) : active;
}

/**
 * 电脑居中、手机底部弹出的对话框，建在 shadcn 的 Dialog 上。Radix 负责焦点进入与焦点圈定；
 * 没有 DialogTrigger，关闭（含卸载）后由这里把焦点还给打开时聚焦的元素。
 * `onOpenChange` 省略时不可通过 Esc、点击遮罩或标题栏 × 关闭（例如只显示一次的密码、提交中），× 也不显示。
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
  plainOnDesktop = false,
}: {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  returnFocus?: React.RefObject<HTMLElement | null>;
  fallbackFocus?: React.RefObject<HTMLElement | null>;
  /**
   * 电脑上不加遮罩、不显示标题栏 ×（运营稿 5b 的重新生成确认）：仍是模态，焦点圈定、Esc 与点击对话框外都照常关闭，
   * 关闭靠「取消」。手机底部面板保留遮罩与 ×。默认关闭，其他对话框不变。
   */
  plainOnDesktop?: boolean;
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
    <Dialog open={open} {...(onOpenChange ? { onOpenChange } : {})}>
      <DialogContent
        showCloseButton={false}
        overlayClassName={cn(plainOnDesktop && 'md:bg-transparent')}
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
            (element) => element?.isConnected && !element.matches(':disabled'),
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
          'inset-x-0 top-auto bottom-0 left-0 flex max-h-[90dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-4 overflow-y-auto rounded-t-2xl rounded-b-none border-0 bg-card px-4 pt-2 pb-7 text-foreground shadow-none sm:max-w-none md:inset-auto md:top-1/2 md:left-1/2 md:w-[520px] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-xl md:border md:border-border md:p-6 md:shadow-[0_16px_48px_rgba(0,0,0,.25)]',
          className,
        )}
      >
        <div
          aria-hidden
          className="h-1 w-10 self-center rounded-sm bg-input md:hidden"
        />
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {description ? (
          <DialogDescription className="sr-only">
            {description}
          </DialogDescription>
        ) : null}
        {children}
        {dismissible ? (
          // 放在内容之后：打开时焦点仍落在第一个字段或按钮上。
          <DialogClose
            aria-label="关闭对话框"
            className={cn(
              'absolute top-6 right-3 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring md:top-5 md:right-5',
              plainOnDesktop && 'md:hidden',
            )}
          >
            <XIcon aria-hidden className="size-4" />
          </DialogClose>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
