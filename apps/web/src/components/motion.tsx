import { useMemo, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { cn } from '../lib/utils';

let pageEnterArmed = false;

const pageEnter =
  'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-motion-out';

/** 骨架屏换成内容：从半透明淡入，文字一开始就能读。 */
export const motionContent =
  'animate-in fade-in-50 duration-base ease-motion-out';

/**
 * 会话里第一次进入带外壳的页面不播放切换动画，之后按 pathname 切换才播。
 * 依赖模块级开关，所以只应在 AppShell 里调用一次。
 */
export function usePageEnterClass() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const className = useMemo(() => {
    const enter = pageEnterArmed;
    pageEnterArmed = true;
    return enter ? pageEnter : undefined;
  }, [pathname]);
  return { pathname, className };
}

/** 有旧数据时刷新：子树按 `aria-busy` 变淡，时长走 `--motion-fast`。 */
export function Refreshing({
  active,
  className,
  children,
}: {
  active: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn('motion-refresh', className)}
      aria-busy={active || undefined}
    >
      {children}
    </div>
  );
}
