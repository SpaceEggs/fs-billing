import { useQuery } from '@tanstack/react-query';
import { Link, useLocation } from '@tanstack/react-router';
import { AppShell } from '../components/app-shell';
import { buttonVariants } from '../components/ui/button';
import { loadSession, sessionQueryKey } from '../lib/session';
import { cn } from '../lib/utils';
import { zoneOfIdentity, zoneOfPath, zones, type Zone } from '../lib/zone';

function NotFoundBody({ zone }: { zone: Zone }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-12 text-center md:px-0 md:pb-10">
      <span
        className={cn(
          'text-5xl leading-normal font-semibold tracking-[-0.03em] tabular-nums md:text-[56px] md:leading-normal',
          zone === 'admin' ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        404
      </span>
      <h1 className="m-0 text-lg font-semibold">找不到这个页面</h1>
      <p className="m-0 text-sm leading-relaxed text-muted-foreground md:leading-normal">
        页面不存在或链接已失效，请检查地址是否正确
      </p>
      <Link
        to={zones[zone].home}
        className={cn(
          buttonVariants({ size: 'lg' }),
          'mt-3 w-full md:mt-2 md:h-9 md:w-auto md:text-sm',
        )}
      >
        返回首页
      </Link>
      {zone === 'admin' ? (
        <span className="hidden text-xs text-muted-foreground md:block">
          返回首页即回到「概览」
        </span>
      ) : null}
    </div>
  );
}

/** 已登录且身份属于该区域时在外壳内显示（第三批 3e/3f、3c/3h），否则单独显示。 */
export function NotFoundPage() {
  const zone = zoneOfPath(useLocation().pathname);
  const session = useQuery({
    queryKey: sessionQueryKey,
    queryFn: loadSession,
    retry: false,
  });
  const identity =
    session.data?.status === 'active' ? session.data.session.identity : null;
  if (session.isPending) return null;
  if (!identity || zoneOfIdentity(identity) !== zone)
    return (
      <div className="flex min-h-dvh flex-col bg-background text-foreground">
        <NotFoundBody zone={zone} />
      </div>
    );
  return (
    <AppShell
      identity={identity}
      title="找不到页面"
      crumb={
        identity.kind === 'customer'
          ? `${identity.tenant.code} · ${identity.tenant.name}`
          : '找不到页面'
      }
      activeNav={null}
    >
      <NotFoundBody zone={zone} />
    </AppShell>
  );
}
