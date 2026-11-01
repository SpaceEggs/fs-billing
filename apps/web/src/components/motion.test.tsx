import { StrictMode, useState } from 'react';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
} from '@tanstack/react-router';
import { beforeEach, expect, it, vi } from 'vitest';

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
