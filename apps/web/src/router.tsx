import { useLayoutEffect } from 'react';
import {
  Outlet,
  type RouterHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  redirect,
  useLocation,
  type ParsedLocation,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { BlockedPage } from './pages/blocked';
import { ErrorPage } from './pages/error';
import { AdminHome, PortalHome } from './pages/home';
import { LoginPage } from './pages/login';
import { NotFoundPage } from './pages/not-found';
import { rememberReturnPath } from './lib/return-to';
import { loadSession, sessionQueryKey, type SessionState } from './lib/session';
import { zoneOfIdentity, zoneOfPath, zones, type Zone } from './lib/zone';

type LoginSearch = { reason?: 'expired' };

function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  return search['reason'] === 'expired' ? { reason: 'expired' } : {};
}

function Root() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    document.documentElement.dataset['product'] = zoneOfPath(pathname);
  }, [pathname]);
  return <Outlet />;
}

/** 每次进入受保护区域都向服务器确认会话，并把结果写入查询缓存供外壳读取。 */
async function requireZone(
  zone: Zone,
  location: ParsedLocation,
  queryClient: QueryClient,
): Promise<{ session: Exclude<SessionState, { status: 'signed-out' }> }> {
  const state = await loadSession();
  queryClient.setQueryData(sessionQueryKey, state);
  if (state.status === 'signed-out') {
    rememberReturnPath(location.href);
    throw redirect({
      to: zones[zone].login,
      search: state.expired ? { reason: 'expired' } : {},
    });
  }
  if (state.status === 'active') {
    const own = zoneOfIdentity(state.session.identity);
    if (own !== zone) throw redirect({ to: zones[own].home });
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
});

const portalHome = createRoute({
  getParentRoute: () => portalLayout,
  path: '/',
  component: PortalIndex,
});

const adminLayout = createRoute({
  getParentRoute: () => rootRoute,
  path: 'admin',
  beforeLoad: ({ context, location }) =>
    requireZone('admin', location, context.queryClient),
});

const adminHome = createRoute({
  getParentRoute: () => adminLayout,
  path: '/',
  component: AdminIndex,
});

function PortalLogin(): React.JSX.Element {
  const { reason } = portalLogin.useSearch();
  return <LoginPage zone="portal" expired={reason === 'expired'} />;
}

function AdminLogin(): React.JSX.Element {
  const { reason } = adminLogin.useSearch();
  return <LoginPage zone="admin" expired={reason === 'expired'} />;
}

function PortalIndex(): React.JSX.Element {
  const { session } = portalHome.useRouteContext();
  return session.status === 'blocked' ? (
    <BlockedPage zone="portal" code={session.code} />
  ) : (
    <PortalHome identity={session.session.identity} />
  );
}

function AdminIndex(): React.JSX.Element {
  const { session } = adminHome.useRouteContext();
  return session.status === 'blocked' ? (
    <BlockedPage zone="admin" code={session.code} />
  ) : (
    <AdminHome identity={session.session.identity} />
  );
}

const routeTree = rootRoute.addChildren([
  portalLogin,
  adminLogin,
  portalLayout.addChildren([portalHome]),
  adminLayout.addChildren([adminHome]),
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
