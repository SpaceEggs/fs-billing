/** 设计系统 · 骨架屏：懒加载页面的代码还在下载。 */
export function PendingPage() {
  return (
    <div
      aria-busy
      aria-label="页面加载中"
      className="flex min-h-dvh flex-col gap-4 bg-background px-6 py-8 text-foreground md:px-10"
    >
      <span className="text-xs text-muted-foreground">加载中</span>
      <div className="h-6 w-40 animate-pulse rounded-md bg-skeleton" />
      <div className="h-[120px] animate-pulse rounded-xl bg-skeleton" />
    </div>
  );
}
