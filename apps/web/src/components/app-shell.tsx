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

/** 后台导航按设计稿顺序；未归属话单、账单、系统告警、操作日志随各自阶段加入。 */
const navigation = {
  portal: [
    { label: '首页', to: zones.portal.home },
    { label: '话单', to: '/portal/cdrs' },
    { label: '余额流水', to: '/portal/ledger' },
    { label: '账号设置', to: '/portal/settings' },
  ],
  admin: [
    { label: '概览', to: zones.admin.home },
    { label: '租户', to: '/admin/tenants' },
    { label: '待收款', to: '/admin/receivables' },
    { label: '管理员', to: '/admin/admins' },
  ],
} as const satisfies Record<Zone, readonly { label: string; to: string }[]>;
export type NavLabel = (typeof navigation)[Zone][number]['label'];

function NavItems({
  zone,
  active,
  mobile = false,
  onNavigate,
}: {
  zone: Zone;
  active: NavLabel | null;
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

/** 手机顶栏 40px 方形按钮（☰、‹、✕、⋯、＋）。 */
export const mobileBarButtonClass =
  'flex size-10 shrink-0 items-center justify-center rounded-lg border border-input text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring';
export const mobileBarPrimaryClass =
  'flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-xl text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring';

/**
 * 登录后的外壳：电脑版左侧导航 + 顶栏（◐ 主题、头像菜单），
 * 手机版顶栏（☰ 抽屉、标题、头像底部面板）。
 * `mobileNav` 替换 ☰（如 ‹ 返回、✕ 关闭），`mobileActions` 放在头像左侧（如 ＋、⋯）。
 */
export function AppShell({
  identity,
  title,
  crumb,
  activeNav,
  mobileNav,
  mobileActions,
  monoTitle = false,
  children,
}: {
  identity: Identity;
  title: string;
  crumb: React.ReactNode;
  activeNav: NavLabel | null;
  mobileNav?: React.ReactNode;
  mobileActions?: React.ReactNode;
  /** 标题是编码时用等宽字体（稿 3a）。 */
  monoTitle?: boolean;
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
        <header className="grid h-[52px] grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border px-4 md:hidden">
          <div className="flex justify-start">
            {mobileNav ?? (
              <Sheet
                side="left"
                title="导航"
                open={drawerOpen}
                onOpenChange={setDrawerOpen}
                trigger={
                  <button
                    type="button"
                    aria-label="打开导航"
                    className={mobileBarButtonClass}
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
            )}
          </div>
          {zone === 'admin' ? (
            <div className="flex min-w-0 flex-col items-center">
              <span
                className={cn(
                  'max-w-full truncate text-base font-semibold',
                  monoTitle && 'font-mono',
                )}
              >
                {title}
              </span>
              <span className="text-[10px] font-medium text-primary">
                {productLabel.admin}
              </span>
            </div>
          ) : (
            <span className="text-base font-semibold">{title}</span>
          )}
          <div className="flex items-center justify-end gap-1.5">
            {mobileActions}
            {zone === 'portal' ? <ThemeMenu mobile /> : null}
            <MobileAccountMenu identity={identity} />
          </div>
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
      </div>
      <SessionExpiredDialog zone={zone} />
    </div>
  );
}

/**
 * 电脑版页面标题行：标题、旁注（如“共 10 个”，与标题基线对齐）或状态标签（与标题垂直居中）
 * 与右侧操作；手机版标题与操作在顶栏，这一行只保留给读屏的 h1（按标题导航）。
 */
export function PageBody({
  title,
  meta,
  badge,
  actions,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5 p-4 md:p-7">
      {meta || badge || actions ? (
        <div className="items-center justify-between gap-3 max-md:sr-only md:flex">
          <div className="flex items-baseline gap-2.5">
            <h1 className="m-0 text-2xl font-semibold tracking-[-0.01em]">
              {title}
            </h1>
            {meta ? (
              <span className="hidden text-[13px] text-muted-foreground md:inline">
                {meta}
              </span>
            ) : null}
            {badge ? (
              <span className="hidden self-center md:flex">{badge}</span>
            ) : null}
          </div>
          {actions ? <div className="hidden md:contents">{actions}</div> : null}
        </div>
      ) : (
        <h1 className="m-0 text-2xl font-semibold max-md:sr-only">{title}</h1>
      )}
      {children}
    </div>
  );
}
