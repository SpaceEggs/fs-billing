import {
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentProps,
} from 'react';
import { useLocation } from '@tanstack/react-router';
import { cn } from '../lib/utils';

const pageEnter =
  'animate-in fade-in-0 slide-in-from-bottom-1 duration-base ease-motion-out';

/** 骨架屏换成内容：从半透明淡入，文字一开始就能读。 */
export const motionContent =
  'animate-in fade-in-50 duration-base ease-motion-out';

function motionDelayMs() {
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue('--motion-delay')
    .trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0;
  return raw.endsWith('ms') ? value : value * 1000;
}

/**
 * 内容就绪时返回淡入 class。挂载时已就绪，或就绪发生在 `--motion-delay` 内，都不播。
 */
export function useMotionContentClass(ready: boolean) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (ready) return;
    setHeld(false);
    const id = window.setTimeout(() => setHeld(true), motionDelayMs());
    return () => window.clearTimeout(id);
  }, [ready]);

  return ready && held ? motionContent : undefined;
}

/**
 * 上次真正提交的路径，和这次该进场的路径。
 * 只在 layout effect 里写：丢弃或挂起的 render 改不到，首屏因此不播。
 * 同一组件换 pathname 时也靠它重新决定进场，不把结果冻在挂载时。
 */
let committedPath: string | null = null;
let enteringPath: string | null = null;

export function usePageEnterClass() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [enter, setEnter] = useState(false);

  useLayoutEffect(() => {
    if (committedPath !== pathname) {
      enteringPath = committedPath === null ? null : pathname;
      committedPath = pathname;
    }
    setEnter(enteringPath === pathname);
  }, [pathname]);

  return { pathname, className: enter ? pageEnter : undefined };
}

/** 有旧数据时刷新：子树按 `data-refreshing` 变淡，时长走 `--motion-fast`。 */
export function Refreshing({
  active,
  className,
  children,
  ...rest
}: ComponentProps<'div'> & { active: boolean }) {
  return (
    <div
      {...rest}
      className={cn('motion-refresh', className)}
      data-refreshing={active ? 'true' : undefined}
    >
      {children}
    </div>
  );
}
