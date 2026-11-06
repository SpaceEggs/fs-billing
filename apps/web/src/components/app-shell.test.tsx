import { QueryClientProvider } from '@tanstack/react-query';
import { screen, within } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import type { Identity } from '@fs-billing/shared';
import { createQueryClient } from '../query-client';
import { customerSession } from '../test/app';
import { renderWithLocale } from '../test/i18n';
import { AppShell } from './app-shell';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

async function renderShell() {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell
        identity={customerSession.identity as Identity}
        title="Home"
        crumb="Home"
        activeNav="首页"
      >
        <div />
      </AppShell>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/portal'] }),
  });
  return renderWithLocale(
    'en',
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('AppShell portal navigation (English)', () => {
  it('shows English navigation labels without Chinese', async () => {
    const { container } = await renderShell();

    const nav = await screen.findByRole('navigation', {
      name: 'Main navigation',
    });
    for (const label of [
      'Home',
      'Calls',
      'Statements',
      'Balance history',
      'Account settings',
    ])
      expect(within(nav).getByRole('link', { name: label })).toBeVisible();

    expect(within(nav).queryByRole('link', { name: '首页' })).toBeNull();
    expect(container).not.toHaveTextContent(HAN);
  });
});
