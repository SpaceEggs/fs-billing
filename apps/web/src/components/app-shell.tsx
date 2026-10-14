import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Identity } from '@fs-billing/shared';
import { cn } from '../lib/utils';
import { zoneOfIdentity, zones, type Zone } from '../lib/zone';
import { AccountMenu, MobileAccountMenu } from './account-menu';
import { productLabel, SidebarBrand } from './brand';
import { SessionExpiredDialog } from './session-expired-dialog';
import { ThemeMenu } from './theme-controls';
import { Sheet } from './ui/sheet';

/** 阶段 4 只有首页；其他导航项随各自阶段的页面加入。 */
const navigation = {
  portal: [{ label: '首页', to: zones.portal.home }],
  admin: [{ label: '概览', to: zones.admin.home }],
} as const satisfies Record<Zone, readonly { label: string; to: string }[]>;

function NavItems({
  zone,
  active,
  mobile = false,
  onNavigate,
}: {
  zone: Zone;
  active: string | null;
  mobile?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav
      aria-label="主导航"
      className={cn('flex flex-col gap-0.5', mobile ? 'text-base' : 'text-sm')}
    >
      {navigation[zone].map((item) => {
        const current = item.label === active;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex items-center rounded-lg',
              mobile ? 'h-11 px-3' : 'h-9 px-2.5',
              !current && 'text-muted-foreground hover:text-foreground',
              current &&
                (zone === 'admin'
                  ? 'bg-brand-soft font-medium text-primary'
                  : 'bg-muted font-semibold text-foreground'),
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 登录后的外壳：电脑版左侧导航 + 顶栏（◐ 主题、头像菜单），
 * 手机版顶栏（☰ 抽屉、标题、头像底部面板）。
 */
export function AppShell({
  identity,
  title,
  crumb,
  activeNav,
  children,
}: {
  identity: Identity;
  title: string;
  crumb: string;
  activeNav: string | null;
  children: React.ReactNode;
}) {
  const zone = zoneOfIdentity(identity);
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="hidden w-[232px] shrink-0 flex-col gap-5 border-r border-border bg-side px-3 py-4 md:flex">
        <SidebarBrand zone={zone} />
        <NavItems zone={zone} active={activeNav} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hidden h-14 items-center justify-between border-b border-border px-7 md:flex">
          <span className="text-sm text-muted-foreground">{crumb}</span>
          <div className="flex items-center gap-2">
            <ThemeMenu />
            <AccountMenu identity={identity} />
          </div>
        </header>
        <header className="flex h-[52px] items-center justify-between border-b border-border px-4 md:hidden">
          <Sheet
            side="left"
            title="导航"
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            trigger={
              <button
                type="button"
                aria-label="打开导航"
                className="flex size-10 items-center justify-center rounded-lg border border-input text-base"
              >
                ☰
              </button>
            }
          >
            <SidebarBrand zone={zone} />
            <NavItems
              zone={zone}
              active={activeNav}
              mobile
              onNavigate={() => setDrawerOpen(false)}
            />
          </Sheet>
          {zone === 'admin' ? (
            <span className="text-[10px] font-medium text-primary">
              {productLabel.admin}
            </span>
          ) : (
            <span className="text-base font-semibold">{title}</span>
          )}
          <MobileAccountMenu identity={identity} />
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
      <SessionExpiredDialog zone={zone} />
    </div>
  );
}

export function PageBody({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 p-4 md:p-7">
      <h1 className="m-0 hidden text-2xl font-semibold md:block">{title}</h1>
      {children}
    </div>
  );
}
