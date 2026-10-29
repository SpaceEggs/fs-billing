import { useSyncExternalStore } from 'react';

/** 与 Tailwind 的 `md` 断点一致：不小于 768 px 为电脑布局，其余为手机。 */
const desktopQuery = '(min-width: 768px)';

function subscribe(onChange: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(desktopQuery);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function snapshot() {
  // 没有 matchMedia（单元测试的 jsdom）按电脑布局处理。
  return typeof window.matchMedia !== 'function'
    ? true
    : window.matchMedia(desktopQuery).matches;
}

/** 当前是电脑布局（`md` 及以上）还是手机布局；窗口跨过断点时更新。 */
export function useIsDesktop() {
  return useSyncExternalStore(subscribe, snapshot, () => true);
}
