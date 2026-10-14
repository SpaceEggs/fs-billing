import { useRouter } from '@tanstack/react-router';
import { Button } from '../components/ui/button';

/** 设计系统 · 空状态 / 错误：加载失败。 */
export function ErrorPage() {
  const router = useRouter();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background px-6 text-center text-foreground">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted text-base font-semibold text-muted-foreground"
      >
        !
      </span>
      <h1 className="m-0 text-base font-semibold">加载失败</h1>
      <p className="m-0 text-sm text-muted-foreground">网络异常，请稍后重试</p>
      <Button
        variant="outline"
        className="mt-2"
        onClick={() => void router.invalidate()}
      >
        重试
      </Button>
    </div>
  );
}
