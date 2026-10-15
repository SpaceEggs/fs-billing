import { useEffect, useLayoutEffect } from 'react';
import {
  Outlet,
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useLocation,
  useRouteContext,
  useRouter,
  type ParsedLocation,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { AdminAccountsPage } from './pages/admin/admin-accounts';
import { AdminPlaceholderPage } from './pages/admin/placeholder';
import { ReceivablesPage } from './pages/admin/receivables';
import { TenantCreatePage } from './pages/admin/tenant-create';
import { TenantDetailPage } from './pages/admin/tenant-detail';
import { TenantEditPage } from './pages/admin/tenant-edit';
import { TenantListPage } from './pages/admin/tenant-list';
import { BlockedPage } from './pages/blocked';
import { ChangePasswordPage } from './pages/change-password';
import { ErrorPage } from './pages/error';
import { AdminHome, PortalHome } from './pages/home';
import { LoginPage } from './pages/login';
import { NotFoundPage } from './pages/not-found';
import {
  validateAdminAccountsSearch,
  validateReceivablesSearch,
  validateTenantDetailSearch,
  validateTenantListSearch,
} from './lib/admin-search';
import { clearBalanceAttempts } from './lib/balance-operation';
import { rememberReturnPath } from './lib/return-to';
import {
  loadSession,
  passwordGate,
  sessionQueryKey,
  usePasswordChangeRequired,
  type SessionState,
} from './lib/session';
import { zoneOfIdentity, zoneOfPath, zones, type Zone } from './lib/zone';

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
  component: PortalLogin,
});

const adminLogin = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin/login',
  validateSearch: validateLoginSearch,
  component: AdminLogin,
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
  component: PortalIndex,
});

const portalChangePassword = createRoute({
  getParentRoute: () => portalLayout,
  path: 'change-password',
  component: () => <ZoneChangePassword zone="portal" />,
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
  component: () => <AdminHome identity={useZoneIdentity()} />,
});

const adminChangePassword = createRoute({
  getParentRoute: () => adminLayout,
  path: 'change-password',
  component: () => <ZoneChangePassword zone="admin" />,
});

const adminTenants = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants',
  validateSearch: validateTenantListSearch,
  component: () => <TenantListPage identity={useZoneIdentity()} />,
});

const adminTenantCreate = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/new',
  component: () => <TenantCreatePage identity={useZoneIdentity()} />,
});

const adminTenantDetail = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/$tenantId',
  validateSearch: validateTenantDetailSearch,
  component: () => <TenantDetailPage identity={useZoneIdentity()} />,
});

const adminTenantEdit = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/$tenantId/edit',
  component: () => <TenantEditPage identity={useZoneIdentity()} />,
});

const adminTenantRateImport = createRoute({
  getParentRoute: () => adminLayout,
  path: 'tenants/$tenantId/rates/import',
  component: () => (
    <AdminPlaceholderPage
      identity={useZoneIdentity()}
      title="导入费率表"
      crumb="租户 / 导入费率表"
      activeNav="租户"
    />
  ),
});

const adminReceivables = createRoute({
  getParentRoute: () => adminLayout,
  path: 'receivables',
  validateSearch: validateReceivablesSearch,
  component: () => <ReceivablesPage identity={useZoneIdentity()} />,
});

const adminAccounts = createRoute({
  getParentRoute: () => adminLayout,
  path: 'admins',
  validateSearch: validateAdminAccountsSearch,
  component: () => <AdminAccountsPage identity={useZoneIdentity()} />,
});

function PortalLogin(): React.JSX.Element {
  const { reason } = portalLogin.useSearch();
  return <LoginPage zone="portal" expired={reason === 'expired'} />;
}

function AdminLogin(): React.JSX.Element {
  const { reason } = adminLogin.useSearch();
  return <LoginPage zone="admin" expired={reason === 'expired'} />;
}

/** 资料停用或身份不可用时，区域内所有页面都显示停用页。 */
function ZoneGuard({
  zone,
  session,
}: {
  zone: Zone;
  session: ZoneSession;
}): React.JSX.Element {
  return session.status === 'blocked' ? (
    <BlockedPage zone={zone} code={session.code} />
  ) : (
    <Outlet />
  );
}

function PortalZone(): React.JSX.Element {
  return (
    <ZoneGuard zone="portal" session={portalLayout.useRouteContext().session} />
  );
}

function AdminZone(): React.JSX.Element {
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

function PortalIndex(): React.JSX.Element {
  return <PortalHome identity={useZoneSession('portal').identity} />;
}

const routeTree = rootRoute.addChildren([
  portalLogin,
  adminLogin,
  portalLayout.addChildren([portalHome, portalChangePassword]),
  adminLayout.addChildren([
    adminHome,
    adminChangePassword,
    adminTenants,
    adminTenantCreate,
    adminTenantDetail,
    adminTenantEdit,
    adminTenantRateImport,
    adminReceivables,
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
  });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
