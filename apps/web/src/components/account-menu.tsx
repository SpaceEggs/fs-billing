import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Link } from '@tanstack/react-router';
import type { Identity } from '@fs-billing/shared';
import { logoutFailedMessage, useLogout } from '../lib/use-logout';
import { cn } from '../lib/utils';
import { zoneOfIdentity } from '../lib/zone';
import { menuContentClass, menuItemClass } from './menu';
import { ThemeSegmented } from './theme-controls';
import { Sheet } from './ui/sheet';

export function accountSummary(identity: Identity) {
  return identity.kind === 'admin'
    ? {
        initial: identity.name.slice(0, 1),
        title: identity.name,
        subtitle: identity.email,
      }
    : {
        initial: identity.tenant.code.slice(0, 1),
        title: identity.email,
        subtitle: `${identity.tenant.name} · ${identity.tenant.code}`,
      };
}

function Avatar({
  identity,
  className,
}: {
  identity: Identity;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
        identity.kind === 'admin'
          ? 'bg-brand-soft text-primary'
          : 'bg-muted text-foreground',
        className,
      )}
    >
      {accountSummary(identity).initial}
    </span>
  );
}

/** 电脑版：右上角头像下拉菜单（第三批 3a）。 */
export function AccountMenu({ identity }: { identity: Identity }) {
  const logout = useLogout(zoneOfIdentity(identity));
  const summary = accountSummary(identity);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger
        aria-label="账号菜单"
        className="group flex h-9 items-center gap-2 rounded-lg py-1 pr-2.5 pl-1 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-muted"
      >
        <Avatar
          identity={identity}
          className={identity.kind === 'customer' ? 'bg-background' : ''}
        />
        {identity.kind === 'admin' ? identity.name : identity.email}
        <span aria-hidden className="group-data-[state=open]:hidden">
          ▾
        </span>
        <span aria-hidden className="hidden group-data-[state=open]:inline">
          ▴
        </span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className={cn(
            menuContentClass,
            identity.kind === 'admin' ? 'w-[250px]' : 'w-[260px]',
          )}
        >
          <div className="mb-1 flex flex-col gap-0.5 border-b border-border px-2.5 pt-2.5 pb-3">
            <span className="font-semibold">{summary.title}</span>
            <span className="text-xs text-muted-foreground">
              {summary.subtitle}
            </span>
          </div>
          {logout.isError ? (
            <p role="alert" className="m-0 px-2.5 py-1.5 text-xs text-neg">
              {logoutFailedMessage}
            </p>
          ) : null}
          {identity.kind === 'customer' ? (
            <DropdownMenu.Item asChild className={menuItemClass}>
              <Link to="/portal/settings">账号设置</Link>
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item
            className={cn(menuItemClass, 'text-neg')}
            disabled={logout.isPending}
            onSelect={(event) => {
              event.preventDefault();
              logout.mutate();
            }}
          >
            退出登录
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** 手机版：头像按钮打开底部面板，包含主题切换与退出登录（第三批 3b/3f）。 */
export function MobileAccountMenu({ identity }: { identity: Identity }) {
  const logout = useLogout(zoneOfIdentity(identity));
  const summary = accountSummary(identity);
  return (
    <Sheet
      side="bottom"
      title="账号菜单"
      trigger={
        <button
          type="button"
          aria-label="账号菜单"
          className="m-[5px] rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
        >
          <Avatar identity={identity} className="size-[30px]" />
        </button>
      }
    >
      <div className="flex items-center gap-3 border-b border-border pt-1 pb-3.5">
        <Avatar identity={identity} className="size-10 text-[15px]" />
        <div className="flex flex-col gap-0.5">
          <span className="text-[15px] font-semibold">{summary.title}</span>
          <span className="text-xs text-muted-foreground">
            {summary.subtitle}
          </span>
        </div>
      </div>
      <div className="flex flex-col gap-2 border-b border-border py-3">
        <span className="text-sm text-muted-foreground">主题</span>
        <ThemeSegmented className="flex w-full" />
      </div>
      {logout.isError ? (
        <p role="alert" className="m-0 pt-3 text-sm text-neg">
          {logoutFailedMessage}
        </p>
      ) : null}
      {identity.kind === 'customer' ? (
        <Link
          to="/portal/settings"
          className="flex h-12 items-center justify-between border-b border-border text-base"
        >
          账号设置
          <span aria-hidden className="text-muted-foreground">
            ›
          </span>
        </Link>
      ) : null}
      <button
        type="button"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
        className="flex h-12 items-center text-base text-neg"
      >
        退出登录
      </button>
    </Sheet>
  );
}
