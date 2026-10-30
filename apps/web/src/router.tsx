import { useEffect, useLayoutEffect } from 'react';
import {
  Outlet,
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useLocation,
  useRouteContext,
  useRouter,
  type ParsedLocation,
  type RouteComponent,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { statementMonthSchema } from '@fs-billing/shared';
import { useFavicon } from './lib/use-favicon';
import { BlockedPage } from './pages/blocked';
import { ErrorPage } from './pages/error';
import { NotFoundPage } from './pages/not-found';
import { PendingPage } from './pages/pending';
import {
  validateAdminAccountsSearch,
  validateAdminStatementsSearch,
  validateAuditLogSearch,
  validateReceivablesSearch,
  validateTenantDetailSearch,
  validateTenantListSearch,
  validateUnassignedSearch,
} from './lib/admin-search';
import { clearBalanceAttempts } from './lib/balance-attempts';
import { validatePortalCdrsSearch } from './lib/cdr-search';
import { validatePortalLedgerSearch } from './lib/portal-ledger';
import { rememberReturnPath } from './lib/return-to';
import {
  loadSession,
  identityBlock,
  passwordGate,
  sessionQueryKey,
  useIdentityBlock,
  usePasswordChangeRequired,
  type SessionState,
} from './lib/session';
import { zoneOfIdentity, zoneOfPath, zones, type Zone } from './lib/zone';

const AdminAccountsPage = lazyRouteComponent(
  () => import('./pages/admin/admin-accounts'),
  'AdminAccountsPage',
);
const ReceivablesPage = lazyRouteComponent(
  () => import('./pages/admin/receivables'),
  'ReceivablesPage',
);
const AdminStatementsPage = lazyRouteComponent(
  () => import('./pages/admin/statements'),
  'AdminStatementsPage',
);
const SystemAlertsPage = lazyRouteComponent(
  () => import('./pages/admin/system-alerts'),
  'SystemAlertsPage',
);
const AdminAuditLogsPage = lazyRouteComponent(
  () => import('./pages/admin/audit-logs'),
  'AdminAuditLogsPage',
);
const UnassignedPage = lazyRouteComponent(
  () => import('./pages/admin/unassigned'),
  'AdminUnassignedPage',
);
const TenantCreatePage = lazyRouteComponent(
  () => import('./pages/admin/tenant-create'),
  'TenantCreatePage',
);
const TenantDetailPage = lazyRouteComponent(
  () => import('./pages/admin/tenant-detail'),
  'TenantDetailPage',
);
const TenantEditPage = lazyRouteComponent(
  () => import('./pages/admin/tenant-edit'),
  'TenantEditPage',
);
const TenantListPage = lazyRouteComponent(
  () => import('./pages/admin/tenant-list'),
  'TenantListPage',
);
const ChangePasswordPage = lazyRouteComponent(
  () => import('./pages/change-password'),
  'ChangePasswordPage',
);
const AdminHome = lazyRouteComponent(() => import('./pages/home'), 'AdminHome');
const PortalHome = lazyRouteComponent(
  () => import('./pages/portal/home'),
  'PortalHome',
);
const PortalCdrsPage = lazyRouteComponent(
  () => import('./pages/portal/cdrs'),
  'PortalCdrsPage',
);
const PortalStatementsPage = lazyRouteComponent(
  () => import('./pages/portal/statements'),
  'PortalStatementsPage',
);
const PortalStatementDetailPage = lazyRouteComponent(
  () => import('./pages/portal/statement-detail'),
  'PortalStatementDetailPage',
);
const PortalLedgerPage = lazyRouteComponent(
  () => import('./pages/portal/ledger'),
  'PortalLedgerPage',
);
const PortalSettingsPage = lazyRouteComponent(
  () => import('./pages/portal/settings'),
  'PortalSettingsPage',
);
const LoginPage = lazyRouteComponent(
  () => import('./pages/login'),
  'LoginPage',
);

/**
 * 路由组件是读取会话或搜索参数的外层函数，把内层懒加载页面的 preload 交给路由，
 * 导航时先下载页面代码，超过 pendingMs 才显示加载中。
 */
function lazyRoute(
  component: () => React.JSX.Element,
  page: { preload?: () => Promise<void> | undefined },
): RouteComponent {
  return Object.assign(component, { preload: () => page.preload?.() });
}

type LoginSearch = { reason?: 'expired' };

function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  return search['reason'] === 'expired' ? { reason: 'expired' } : {};
}

/** 页面内请求返回 PASSWORD_CHANGE_REQUIRED 时，跳到所在区域的改密页并记住当前页。 */
function usePasswordGateRedirect(pathname: string) {
  const required = usePasswordChangeRequired();
  const router = useRouter();
  useEffect(() => {
    if (!required) return;
    const zone = zones[zoneOfPath(pathname)];
    if (pathname === zone.changePassword || pathname === zone.login) return;
    rememberReturnPath(router.state.location.href);
    void router.navigate({ to: zone.changePassword });
  }, [required, pathname, router]);
}

function Root() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    document.documentElement.dataset['product'] = zoneOfPath(pathname);
  }, [pathname]);
  usePasswordGateRedirect(pathname);
  return <Outlet />;
}

export type ZoneSession = Exclude<SessionState, { status: 'signed-out' }>;

/**
 * 每次进入受保护区域都向服务器确认会话，并把结果写入查询缓存供外壳读取。
 * 需要改密的会话只能停留在改密页。
 */
async function requireZone(
  zone: Zone,
  location: ParsedLocation,
  queryClient: QueryClient,
): Promise<{ session: ZoneSession }> {
  const state = await loadSession();
  queryClient.setQueryData(sessionQueryKey, state);
  if (state.status === 'signed-out') {
    clearBalanceAttempts();
    rememberReturnPath(location.href);
    throw redirect({
      to: zones[zone].login,
      search: state.expired ? { reason: 'expired' } : {},
    });
  }
  if (state.status === 'active') {
    identityBlock.clear();
    const own = zoneOfIdentity(state.session.identity);
    if (own !== zone) throw redirect({ to: zones[own].home });
    passwordGate.set(state.session.passwordChangeRequired);
    if (
      state.session.passwordChangeRequired &&
      location.pathname !== zones[zone].changePassword
    ) {
      rememberReturnPath(location.href);
      throw redirect({ to: zones[zone].changePassword });
    }
  }
  return { session: state };
}

const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: NotFoundPage,
  errorComponent: ErrorPage,
});

const portalLogin = createRoute({
  getParentRoute: () => rootRoute,
  path: 'login',
  validateSearch: validateLoginSearch,
  component: lazyRoute(PortalLogin, LoginPage),
});

const adminLogin = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/login',
  validateSearch: validateLoginSearch,
  component: lazyRoute(AdminLogin, LoginPage),
});

const portalLayout = createRoute({
  getParentRoute: () => rootRoute,
  id: 'portal',
  beforeLoad: ({ context, location }) =>
    requireZone('portal', location, context.queryClient),
  component: PortalZone,
});

const portalHome = createRoute({
  getParentRoute: () => portalLayout,
  path: '/',
  component: lazyRoute(PortalIndex, PortalHome),
});

const portalCdrs = createRoute({
  getParentRoute: () => portalLayout,
  path: 'portal/cdrs',
  validateSearch: validatePortalCdrsSearch,
  component: lazyRoute(
    () => <PortalCdrsPage identity={useZoneSession('portal').identity} />,
    PortalCdrsPage,
  ),
});

const portalStatements = createRoute({
  getParentRoute: () => portalLayout,
  path: 'portal/statements',
  component: lazyRoute(
    () => <PortalStatementsPage identity={useZoneSession('portal').identity} />,
    PortalStatementsPage,
  ),
});

const portalStatementDetail = createRoute({
  getParentRoute: () => portalLayout,
  path: 'portal/statements/$month',
  component: lazyRoute(PortalStatementDetailRoute, PortalStatementDetailPage),
});

const portalChangePassword = createRoute({
  getParentRoute: () => portalLayout,
  path: 'change-password',
  component: lazyRoute(
    () => <ZoneChangePassword zone="portal" />,
    ChangePasswordPage,
  ),
});

const portalLedger = createRoute({
  getParentRoute: () => portalLayout,
  path: 'portal/ledger',
  validateSearch: validatePortalLedgerSearch,
  component: lazyRoute(PortalLedgerRoute, PortalLedgerPage),
});

const portalSettings = createRoute({
  getParentRoute: () => portalLayout,
  path: 'portal/settings',
  component: lazyRoute(
    () => <PortalSettingsPage identity={useZoneSession('portal').identity} />,
    PortalSettingsPage,
  ),
});

const adminLayout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin',
  beforeLoad: ({ context, location }) =>
    requireZone('admin', location, context.queryClient),
  component: AdminZone,
});

const adminHome = createRoute({
  getParentRoute: () => adminLayout,
  path: '/',
  component: lazyRoute(
    () => <AdminHome identity={useZoneIdentity()} />,
    AdminHome,
  ),
});

const adminChangePassword = createRoute({
  getParentRoute: () => adminLayout,
  path: 'change-password',
  component: lazyRoute(
    () => <ZoneChangePassword zone="admin" />,
    ChangePasswordPage,
  ),
});

const adminTenants = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants',
  validateSearch: validateTenantListSearch,
  component: lazyRoute(
    () => <TenantListPage identity={useZoneIdentity()} />,
    TenantListPage,
  ),
});

const adminTenantCreate = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/new',
  component: lazyRoute(
    () => <TenantCreatePage identity={useZoneIdentity()} />,
    TenantCreatePage,
  ),
});

const adminTenantDetail = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/$tenantId',
  validateSearch: validateTenantDetailSearch,
  component: lazyRoute(
    () => <TenantDetailPage identity={useZoneIdentity()} />,
    TenantDetailPage,
  ),
});

const adminTenantEdit = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/$tenantId/edit',
  component: lazyRoute(
    () => <TenantEditPage identity={useZoneIdentity()} />,
    TenantEditPage,
  ),
});

const adminReceivables = createRoute({
  getParentRoute: () => adminLayout,
  path: 'receivables',
  validateSearch: validateReceivablesSearch,
  component: lazyRoute(
    () => <ReceivablesPage identity={useZoneIdentity()} />,
    ReceivablesPage,
  ),
});

const adminUnassigned = createRoute({
  getParentRoute: () => adminLayout,
  path: 'unassigned',
  validateSearch: validateUnassignedSearch,
  component: lazyRoute(
    () => <UnassignedPage identity={useZoneIdentity()} />,
    UnassignedPage,
  ),
});

const adminStatements = createRoute({
  getParentRoute: () => adminLayout,
  path: 'statements',
  validateSearch: validateAdminStatementsSearch,
  component: lazyRoute(
    () => <AdminStatementsPage identity={useZoneIdentity()} />,
    AdminStatementsPage,
  ),
});

const adminSystemAlerts = createRoute({
  getParentRoute: () => adminLayout,
  path: 'system-alerts',
  validateSearch: (
    raw: Record<string, unknown>,
  ): { window?: '24h' | undefined; tab?: 'settings' | undefined } => ({
    window: raw['window'] === '24h' ? '24h' : undefined,
    tab: raw['tab'] === 'settings' ? 'settings' : undefined,
  }),
  component: lazyRoute(
    () => <SystemAlertsPage identity={useZoneIdentity()} />,
    SystemAlertsPage,
  ),
});

const adminAuditLogs = createRoute({
  getParentRoute: () => adminLayout,
  path: 'audit-logs',
  validateSearch: validateAuditLogSearch,
  component: lazyRoute(
    () => <AdminAuditLogsPage identity={useZoneIdentity()} />,
    AdminAuditLogsPage,
  ),
});

const adminAccounts = createRoute({
  getParentRoute: () => adminLayout,
  path: 'admins',
  validateSearch: validateAdminAccountsSearch,
  component: lazyRoute(
    () => <AdminAccountsPage identity={useZoneIdentity()} />,
    AdminAccountsPage,
  ),
});

function PortalLogin(): React.JSX.Element {
  const { reason } = portalLogin.useSearch();
  return <LoginPage zone="portal" expired={reason === 'expired'} />;
}

function AdminLogin(): React.JSX.Element {
  const { reason } = adminLogin.useSearch();
  return <LoginPage zone="admin" expired={reason === 'expired'} />;
}

/** 资料停用或身份不可用（进入区域时或页面内请求得知）时，区域内所有页面都显示停用页。 */
function ZoneGuard({
  zone,
  session,
}: {
  zone: Zone;
  session: ZoneSession;
}): React.JSX.Element {
  const blocked =
    useIdentityBlock() ?? (session.status === 'blocked' ? session.code : null);
  return blocked ? <BlockedPage zone={zone} code={blocked} /> : <Outlet />;
}

function PortalZone(): React.JSX.Element {
  return (
    <ZoneGuard zone="portal" session={portalLayout.useRouteContext().session} />
  );
}

function AdminZone(): React.JSX.Element {
  useFavicon();
  return (
    <ZoneGuard zone="admin" session={adminLayout.useRouteContext().session} />
  );
}

/** 区域布局已拦截 blocked，子页面只会在 active 会话下渲染。 */
function useZoneSession(zone: Zone) {
  const { session } = useRouteContext({
    from: zone === 'admin' ? '/admin' : '/portal',
  });
  if (session.status !== 'active')
    throw new Error('Zone page rendered without an active session');
  return session.session;
}

function useZoneIdentity() {
  return useZoneSession('admin').identity;
}

function ZoneChangePassword({ zone }: { zone: Zone }): React.JSX.Element {
  const forced = useZoneSession(zone).passwordChangeRequired;
  return <ChangePasswordPage zone={zone} forced={forced} />;
}

function PortalLedgerRoute(): React.JSX.Element {
  const navigate = portalLedger.useNavigate();
  return (
    <PortalLedgerPage
      identity={useZoneSession('portal').identity}
      search={portalLedger.useSearch()}
      onSearch={(patch) =>
        void navigate({
          search: (current) => ({ ...current, ...patch }),
          replace: true,
        })
      }
    />
  );
}

function PortalStatementDetailRoute(): React.JSX.Element {
  const { month } = portalStatementDetail.useParams();
  const { identity } = useZoneSession('portal');
  // 月份写法不对的地址是找不到的页面，不发请求。
  if (!statementMonthSchema.safeParse(month).success) return <NotFoundPage />;
  return <PortalStatementDetailPage identity={identity} month={month} />;
}

function PortalIndex(): React.JSX.Element {
  return <PortalHome identity={useZoneSession('portal').identity} />;
}

const routeTree = rootRoute.addChildren([
  portalLogin,
  adminLogin,
  portalLayout.addChildren([
    portalHome,
    portalCdrs,
    portalStatements,
    portalStatementDetail,
    portalChangePassword,
    portalLedger,
    portalSettings,
  ]),
  adminLayout.addChildren([
    adminHome,
    adminChangePassword,
    adminTenants,
    adminTenantCreate,
    adminTenantDetail,
    adminTenantEdit,
    adminReceivables,
    adminUnassigned,
    adminStatements,
    adminSystemAlerts,
    adminAuditLogs,
    adminAccounts,
  ]),
]);

export function createAppRouter(
  queryClient: QueryClient,
  history?: RouterHistory,
) {
  return createRouter({
    routeTree,
    context: { queryClient },
    ...(history ? { history } : {}),
    notFoundMode: 'root',
    defaultPreload: false,
    defaultPendingComponent: PendingPage,
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
