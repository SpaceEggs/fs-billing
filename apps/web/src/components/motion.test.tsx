import { StrictMode } from 'react';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
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
