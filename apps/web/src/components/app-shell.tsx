import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  Building2Icon,
  FileTextIcon,
  HandCoinsIcon,
  HouseIcon,
  LayoutDashboardIcon,
  MenuIcon,
  PhoneCallIcon,
  PhoneMissedIcon,
  ReceiptIcon,
  ScrollTextIcon,
  SettingsIcon,
  ShieldUserIcon,
  WalletIcon,
  type LucideIcon,
} from 'lucide-react';
import type { Identity } from '@fs-billing/shared';
import { apiQuery } from '../lib/admin-api';
import { cn } from '../lib/utils';
import { zoneOfIdentity, zones, type Zone } from '../lib/zone';
import { AccountMenu, MobileAccountMenu } from './account-menu';
import { productLabel, SidebarBrand } from './brand';
import { SessionExpiredDialog } from './session-expired-dialog';
import { MobileBarButton } from './mobile-bar-button';
import { ThemeMenu } from './theme-controls';
import { SheetPanel } from './sheet-panel';

/** 后台导航按设计稿顺序；未归属话单带待处理条数角标，操作日志在账单之后。系统告警随该阶段加入。 */
const navigation = {
  portal: [
    { label: '首页', to: zones.portal.home, icon: HouseIcon },
    { label: '话单', to: '/portal/cdrs', icon: PhoneCallIcon },
    { label: '月账单', to: '/portal/statements', icon: FileTextIcon },
    { label: '余额流水', to: '/portal/ledger', icon: WalletIcon },
    { label: '账号设置', to: '/portal/settings', icon: SettingsIcon },
  ],
  admin: [
    { label: '概览', to: zones.admin.home, icon: LayoutDashboardIcon },
    { label: '租户', to: '/admin/tenants', icon: Building2Icon },
    { label: '待收款', to: '/admin/receivables', icon: HandCoinsIcon },
    { label: '未归属话单', to: '/admin/unassigned', icon: PhoneMissedIcon },
    { label: '账单', to: '/admin/statements', icon: ReceiptIcon },
    { label: '操作日志', to: '/admin/audit-logs', icon: ScrollTextIcon },
    { label: '管理员', to: '/admin/admins', icon: ShieldUserIcon },
  ],
} as const satisfies Record<
  Zone,
  readonly { label: string; to: string; icon: LucideIcon }[]
>;
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
  const pending = useQuery({
    ...apiQuery('adminUnassignedSummary'),
    enabled: zone === 'admin',
  });
  const pendingCount =
    zone === 'admin' && pending.data && pending.data.pending > 0
      ? pending.data.pending
      : null;
  return (
    <nav
      aria-label="主导航"
      className={cn('flex flex-col gap-0.5', mobile ? 'text-base' : 'text-sm')}
    >
      {navigation[zone].map((item) => {
        const current = item.label === active;
        const Icon = item.icon;
        return (
          <Link
            key={item.to}
            to={item.to}
            onClick={onNavigate}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2.5 rounded-lg',
              mobile ? 'h-11 px-3' : 'h-9 px-2.5',
              item.to === '/admin/unassigned' && 'w-full',
              !current && 'text-muted-foreground hover:text-foreground',
              current &&
                (zone === 'admin'
                  ? 'bg-brand-soft font-medium text-primary'
                  : 'bg-muted font-semibold text-foreground'),
            )}
          >
            <Icon
              aria-hidden
              className={cn('shrink-0', mobile ? 'size-[18px]' : 'size-4')}
            />
            {item.label}
            {item.to === '/admin/unassigned' && pendingCount !== null ? (
              <span className="ml-auto pl-2 text-[11px] tabular-nums text-muted-foreground">
                {pendingCount.toLocaleString('en-US')}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * 登录后的外壳：电脑版左侧导航 + 顶栏（主题、头像菜单），
 * 手机版顶栏（菜单抽屉、标题、头像底部面板）。
 * `mobileNav` 替换菜单按钮（如返回、关闭），`mobileActions` 放在头像左侧（如新增、更多）。
 */
export function AppShell({
  identity,
  title,
  crumb,
  activeNav,
  mobileNav,
  mobileActions,
  monoTitle = false,
  narrowTopbar = false,
  centerTitle = false,
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
  /**
   * 1280 px 以下（门户月账单列表稿 1b）：电脑顶栏不显示左侧的租户名，头像旁不显示邮箱，只留 ◐ 与头像。
   * 默认关闭，其他页面的顶栏不变。
   */
  narrowTopbar?: boolean;
  /**
   * 手机顶栏的标题绝对居中（门户月账单详情稿 2b、3b）；右侧的 ⋯ ◐ 头像排得更紧。
   * 默认关闭，其他页面仍是三列网格。
   */
  centerTitle?: boolean;
  children: React.ReactNode;
}) {
  const zone = zoneOfIdentity(identity);
  const [drawerOpen, setDrawerOpen] = useState(false);
  return (
    <div className="flex min-h-dvh bg-background text-foreground">
      <aside className="hidden w-[232px] shrink-0 flex-col gap-5 border-r border-border bg-side px-3 py-4 md:flex print:hidden">
        <SidebarBrand zone={zone} />
        <NavItems zone={zone} active={activeNav} />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="hidden h-14 items-center justify-between border-b border-border px-7 md:flex print:hidden">
          <span
            className={cn(
              'text-sm text-muted-foreground',
              narrowTopbar && 'max-xl:invisible',
            )}
          >
            {crumb}
          </span>
          <div className="flex items-center gap-2">
            <ThemeMenu />
            <AccountMenu identity={identity} condensedBelowXl={narrowTopbar} />
          </div>
        </header>
        <header
          className={cn(
            'grid h-[52px] grid-cols-[1fr_auto_1fr] items-center gap-2 border-b border-border px-4 md:hidden print:hidden',
            centerTitle && 'relative',
          )}
        >
          <div className="flex justify-start">
            {mobileNav ?? (
              <SheetPanel
                side="left"
                title="导航"
                open={drawerOpen}
                onOpenChange={setDrawerOpen}
                trigger={
                  <MobileBarButton aria-label="打开导航">
                    <MenuIcon aria-hidden />
                  </MobileBarButton>
                }
              >
                <SidebarBrand zone={zone} />
                <NavItems
                  zone={zone}
                  active={activeNav}
                  mobile
                  onNavigate={() => setDrawerOpen(false)}
                />
              </SheetPanel>
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
            <span
              className={cn(
                'text-base font-semibold',
                centerTitle &&
                  'absolute left-1/2 max-w-[45%] -translate-x-1/2 truncate',
              )}
            >
              {title}
            </span>
          )}
          <div
            className={cn(
              'flex items-center justify-end gap-1.5',
              centerTitle && 'col-start-3 gap-0.5',
            )}
          >
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
