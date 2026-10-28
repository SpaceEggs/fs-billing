import { ChevronDownIcon, ChevronRightIcon, ChevronUpIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type { Identity } from '@fs-billing/shared';
import { Button } from './ui/button';
import { logoutFailedMessage, useLogout } from '../lib/use-logout';
import { cn } from '../lib/utils';
import { zoneOfIdentity } from '../lib/zone';
import { menuContentClass, menuItemClass } from './menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { ThemeSegmented } from './theme-controls';
import { SheetPanel } from './sheet-panel';

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
export function AccountMenu({
  identity,
  condensedBelowXl = false,
}: {
  identity: Identity;
  /** 1280 px 以下只显示头像（门户月账单列表稿 1b），其余页面不传。 */
  condensedBelowXl?: boolean;
}) {
  const logout = useLogout(zoneOfIdentity(identity));
  const summary = accountSummary(identity);
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label="账号菜单"
        className="group flex h-9 items-center gap-2 rounded-lg py-1 pr-2.5 pl-1 text-[13px] outline-none focus-visible:ring-[3px] focus-visible:ring-ring data-[state=open]:bg-muted"
      >
        <Avatar
          identity={identity}
          className={identity.kind === 'customer' ? 'bg-background' : ''}
        />
        <span className={cn(condensedBelowXl && 'max-xl:hidden')}>
          {identity.kind === 'admin' ? identity.name : identity.email}
        </span>
        <ChevronDownIcon
          aria-hidden
          className={cn(
            'size-3.5 group-data-[state=open]:hidden',
            condensedBelowXl && 'max-xl:hidden',
          )}
        />
        <ChevronUpIcon
          aria-hidden
          className={cn(
            'hidden size-3.5 group-data-[state=open]:inline',
            condensedBelowXl && 'max-xl:group-data-[state=open]:hidden',
          )}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
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
          <DropdownMenuItem asChild className={menuItemClass}>
            <Link to="/portal/settings">账号设置</Link>
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          className={cn(menuItemClass, 'text-neg focus:text-neg')}
          disabled={logout.isPending}
          onSelect={(event) => {
            event.preventDefault();
            logout.mutate();
          }}
        >
          退出登录
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 手机版：头像按钮打开底部面板，包含主题切换与退出登录（第三批 3b/3f）。 */
export function MobileAccountMenu({ identity }: { identity: Identity }) {
  const logout = useLogout(zoneOfIdentity(identity));
  const summary = accountSummary(identity);
  return (
    <SheetPanel
      side="bottom"
      title="账号菜单"
      trigger={
        <Button
          variant="ghost"
          size="inline"
          aria-label="账号菜单"
          className="m-[5px] rounded-full hover:bg-transparent"
        >
          <Avatar identity={identity} className="size-[30px]" />
        </Button>
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
          <ChevronRightIcon
            aria-hidden
            className="size-4 text-muted-foreground"
          />
        </Link>
      ) : null}
      <Button
        variant="ghost"
        size="inline"
        disabled={logout.isPending}
        onClick={() => logout.mutate()}
        className="h-12 justify-start rounded-none text-base text-neg hover:bg-transparent"
      >
        退出登录
      </Button>
    </SheetPanel>
  );
}
