import { translate } from '@fs-billing/shared';
import { useRouter } from '@tanstack/react-router';
import { Button } from '../components/ui/button';
import { useLocale } from '../i18n';

/** 设计系统 · 空状态 / 错误：加载失败。 */
export function ErrorPage() {
  const locale = useLocale();
  const router = useRouter();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-2 bg-background px-6 text-center text-foreground">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted text-base font-semibold text-muted-foreground"
      >
        !
      </span>
      <h1 className="m-0 text-base font-semibold">
        {translate(locale, 'common:error.loadFailedTitle')}
      </h1>
      <p className="m-0 text-sm text-muted-foreground">
        {translate(locale, 'common:error.loadNetworkBody')}
      </p>
      <Button
        variant="outline"
        className="mt-2"
        onClick={() => void router.invalidate()}
      >
        {translate(locale, 'common:action.retry')}
      </Button>
    </div>
  );
}
