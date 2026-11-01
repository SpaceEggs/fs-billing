import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from '@tanstack/react-router';
import { cn } from '../lib/utils';

const pageEnter =
  'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-motion-out';

/** 骨架屏换成内容：从半透明淡入，文字一开始就能读。 */
export const motionContent =
  'animate-in fade-in-50 duration-base ease-motion-out';

/**
 * AppShell 随页面重挂载，所以上次提交的路径记在模块里。
 * 只在 effect 里写入挂载时的路径，被丢弃的 render 不会让首屏也播动画。
 */
let committedPath: string | null = null;

export function usePageEnterClass() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [mountedPath] = useState(pathname);
  const [enter] = useState(
    () => committedPath !== null && committedPath !== mountedPath,
  );

  useEffect(() => {
    committedPath = mountedPath;
  }, [mountedPath]);

  return { pathname, className: enter ? pageEnter : undefined };
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
