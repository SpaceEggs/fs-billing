import { translate } from '@fs-billing/shared';
import { Skeleton } from '../components/ui/skeleton';
import { useLocale } from '../i18n';

/** 设计系统 · 骨架屏：懒加载页面的代码还在下载。 */
export function PendingPage() {
  const locale = useLocale();
  return (
    <div
      aria-busy
      aria-label={translate(locale, 'common:loading.page')}
      className="flex min-h-dvh flex-col gap-4 bg-background px-6 py-8 text-foreground md:px-10"
    >
      <span className="text-xs text-muted-foreground">
        {translate(locale, 'common:loading.label')}
      </span>
      <Skeleton className="h-6 w-40 rounded-md" />
      <Skeleton className="h-[120px] rounded-xl" />
    </div>
  );
}
