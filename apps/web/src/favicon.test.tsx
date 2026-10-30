import { act, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { adminSession, renderApp } from './test/app';

afterEach(() => {
  document.head.querySelector('link[type="image/svg+xml"]')?.remove();
  vi.unstubAllGlobals();
});

it('switches to the admin icon in the admin layout and restores the portal icon on exit', async () => {
  const icon = document.createElement('link');
  icon.rel = 'icon';
  icon.type = 'image/svg+xml';
  icon.href = '/favicon-portal.svg';
  document.head.append(icon);
  const { router } = renderApp('/admin', (path) => {
    if (path === '/api/auth/session')
      return { status: 200, body: adminSession };
    return { status: 200, body: {} };
  });

  await waitFor(() =>
    expect(icon.getAttribute('href')).toBe('/favicon-admin.svg'),
  );
  await act(async () => {
    await router.navigate({ to: '/login' });
  });
  await waitFor(() =>
    expect(icon.getAttribute('href')).toBe('/favicon-portal.svg'),
  );
});
