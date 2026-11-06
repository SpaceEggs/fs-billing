import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminApi, customerSession, renderAppWithLocale } from '../test/app';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const englishSession = {
  ...customerSession,
  identity: {
    ...customerSession.identity,
    locale: 'en',
    tenant: {
      ...customerSession.identity.tenant,
      name: 'Shenzhen Example Technology Ltd',
    },
  },
};

function renderPage(path: string) {
  const { handler } = adminApi({}, englishSession);
  return renderAppWithLocale('en', path, handler);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('auth and generic pages (English)', () => {
  it('renders the portal login page in English without Chinese', async () => {
    const { container } = await renderPage('/login');

    expect(
      await screen.findByRole('heading', { name: 'Sign in' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Email')).toBeVisible();
    expect(screen.getByLabelText('Password')).toBeVisible();
    expect(screen.getAllByText('Forgot password?').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('uses the admin product name on the admin login page', async () => {
    const { container } = await renderPage('/admin/login');

    expect(
      (await screen.findAllByRole('heading', { name: 'Sign in to admin' }))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
    expect(
      screen.getByText('Customers sign in through the customer portal'),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the change-password page in English without Chinese', async () => {
    const { container } = await renderPage('/change-password');

    expect(
      await screen.findByRole('heading', { name: 'Change password' }),
    ).toBeVisible();
    expect(screen.getByLabelText('Current password')).toBeVisible();
    expect(screen.getByLabelText('New password')).toBeVisible();
    expect(screen.getByLabelText('Confirm new password')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the not-found page in English without Chinese', async () => {
    const { container } = await renderPage('/portal/missing');

    expect(
      await screen.findByRole('heading', { name: 'Page not found' }),
    ).toBeVisible();
    expect(
      screen.getByText(
        'This page does not exist or the link has expired. Check the address',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to home' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
