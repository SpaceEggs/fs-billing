import { StrictMode, useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  useSearch,
} from '@tanstack/react-router';
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest';

// 模块里记着上次提交的路径，每个用例从空白会话开始。
beforeEach(() => {
  vi.resetModules();
});

it('plays the page enter only after a committed navigation', async () => {
  const { usePageEnterClass } = await import('./motion');

  function PageA() {
    const page = usePageEnterClass();
    return <h1 data-enter={page.className ? 'yes' : 'no'}>A</h1>;
  }
  function PageB() {
    const page = usePageEnterClass();
    return <h1 data-enter={page.className ? 'yes' : 'no'}>B</h1>;
  }

  const root = createRootRoute({
    component: () => <Outlet />,
  });
  const first = createRoute({
    getParentRoute: () => root,
    path: '/login',
    component: PageA,
  });
  const second = createRoute({
    getParentRoute: () => root,
    path: '/admin',
    component: PageB,
  });
  const router = createRouter({
    routeTree: root.addChildren([first, second]),
    history: createMemoryHistory({ initialEntries: ['/login'] }),
  });
  await router.load();
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );

  expect(screen.getByRole('heading', { name: 'A' })).toHaveAttribute(
    'data-enter',
    'no',
  );

  await router.navigate({ to: '/admin' });

  expect(screen.getByRole('heading', { name: 'B' })).toHaveAttribute(
    'data-enter',
    'yes',
  );
});

it('plays the page enter when a pathname change reuses the page', async () => {
  const { usePageEnterClass } = await import('./motion');
  let mounts = 0;

  function Page() {
    useState(() => {
      mounts += 1;
    });
    const page = usePageEnterClass();
    const { tenantId } = useParams({ strict: false });
    return <h1 data-enter={page.className ? 'yes' : 'no'}>{tenantId}</h1>;
  }

  const root = createRootRoute({
    component: () => <Outlet />,
  });
  const tenant = createRoute({
    getParentRoute: () => root,
    path: '/admin/tenants/$tenantId',
    component: Page,
  });
  const router = createRouter({
    routeTree: root.addChildren([tenant]),
    history: createMemoryHistory({ initialEntries: ['/admin/tenants/a'] }),
  });
  await router.load();
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );

  expect(screen.getByRole('heading', { name: 'a' })).toHaveAttribute(
    'data-enter',
    'no',
  );
  const mounted = mounts;

  await router.navigate({
    to: '/admin/tenants/$tenantId',
    params: { tenantId: 'b' },
  });

  expect(mounts).toBe(mounted);
  expect(screen.getByRole('heading', { name: 'b' })).toHaveAttribute(
    'data-enter',
    'yes',
  );
});

it('dims a refresh with data-refreshing and leaves aria alone', async () => {
  const { Refreshing } = await import('./motion');
  const { rerender } = render(
    <Refreshing active={false}>
      <p>rows</p>
    </Refreshing>,
  );
  const region = screen.getByText('rows').parentElement;
  expect(region).not.toHaveAttribute('aria-busy');
  expect(region).not.toHaveAttribute('data-refreshing');

  rerender(
    <Refreshing active>
      <p>rows</p>
    </Refreshing>,
  );
  expect(region).toHaveAttribute('data-refreshing', 'true');
  expect(region).not.toHaveAttribute('aria-busy');

  rerender(
    <Refreshing active aria-busy={false}>
      <p>rows</p>
    </Refreshing>,
  );
  expect(region).toHaveAttribute('aria-busy', 'false');
  expect(region).toHaveAttribute('data-refreshing', 'true');
});

it('does not play the page enter or remount on search-only navigation', async () => {
  const { usePageEnterClass } = await import('./motion');
  let mounts = 0;

  function Shell() {
    const page = usePageEnterClass();
    return (
      <main key={page.pathname} data-enter={page.className ? 'yes' : 'no'}>
        <Outlet />
      </main>
    );
  }
  function Page() {
    useState(() => {
      mounts += 1;
    });
    const search = useSearch({ strict: false });
    return <h1>{typeof search.tab === 'string' ? search.tab : 'pending'}</h1>;
  }

  const root = createRootRoute({
    component: Shell,
  });
  const unassigned = createRoute({
    getParentRoute: () => root,
    path: '/admin/unassigned',
    validateSearch: (search: Record<string, unknown>) => ({
      tab: typeof search.tab === 'string' ? search.tab : undefined,
    }),
    component: Page,
  });
  const router = createRouter({
    routeTree: root.addChildren([unassigned]),
    history: createMemoryHistory({ initialEntries: ['/admin/unassigned'] }),
  });
  await router.load();
  render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );

  const main = screen.getByRole('main');
  expect(main).toHaveAttribute('data-enter', 'no');
  expect(screen.getByRole('heading', { name: 'pending' })).toBeVisible();
  const mounted = mounts;

  await router.navigate({
    to: '/admin/unassigned',
    search: { tab: 'ignored' },
  });

  expect(screen.getByRole('main')).toBe(main);
  expect(mounts).toBe(mounted);
  expect(main).toHaveAttribute('data-enter', 'no');
  expect(screen.getByRole('heading', { name: 'ignored' })).toBeVisible();
});

function delayToken(ms: number) {
  document.documentElement.style.setProperty('--motion-delay', `${ms}ms`);
  onTestFinished(() => {
    document.documentElement.style.removeProperty('--motion-delay');
    vi.useRealTimers();
  });
}

it('does not fade content that is ready on mount', async () => {
  delayToken(80);
  vi.useFakeTimers();
  const { useMotionContentClass } = await import('./motion');

  function Probe({ ready }: { ready: boolean }) {
    const fade = useMotionContentClass(ready);
    return ready ? <p className={fade}>content</p> : <p>skeleton</p>;
  }

  render(
    <StrictMode>
      <Probe ready />
    </StrictMode>,
  );
  expect(screen.getByText('content')).not.toHaveClass('animate-in');

  await act(() => vi.advanceTimersByTimeAsync(80));
  expect(screen.getByText('content')).not.toHaveClass('animate-in');
});

it('does not fade content that arrives within the delay', async () => {
  delayToken(80);
  vi.useFakeTimers();
  const { useMotionContentClass } = await import('./motion');

  function Probe({ ready }: { ready: boolean }) {
    const fade = useMotionContentClass(ready);
    return ready ? <p className={fade}>content</p> : <p>skeleton</p>;
  }

  const { rerender } = render(
    <StrictMode>
      <Probe ready={false} />
    </StrictMode>,
  );
  expect(screen.getByText('skeleton')).toBeVisible();

  await act(() => vi.advanceTimersByTimeAsync(79));
  rerender(
    <StrictMode>
      <Probe ready />
    </StrictMode>,
  );
  expect(screen.getByText('content')).not.toHaveClass('animate-in');
});

it('fades content after the skeleton was held past the delay', async () => {
  delayToken(80);
  vi.useFakeTimers();
  const { motionContent, useMotionContentClass } = await import('./motion');

  function Probe({ ready }: { ready: boolean }) {
    const fade = useMotionContentClass(ready);
    return ready ? <p className={fade}>content</p> : <p>skeleton</p>;
  }

  const { rerender } = render(
    <StrictMode>
      <Probe ready={false} />
    </StrictMode>,
  );
  expect(screen.getByText('skeleton')).toBeVisible();

  await act(() => vi.advanceTimersByTimeAsync(80));
  rerender(
    <StrictMode>
      <Probe ready />
    </StrictMode>,
  );
  expect(screen.getByText('content')).toHaveClass(
    ...motionContent.split(/\s+/),
  );
});
