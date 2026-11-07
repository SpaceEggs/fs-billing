import { screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import {
  AccountStatusDialog,
  ResetPasswordDialog,
  StatusChangeNotice,
  TemporaryPassword,
} from './account-dialogs';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('account dialogs (English)', () => {
  it('renders the one-time password warning and a status notice', async () => {
    const { container } = await renderWithLocale(
      'en',
      <>
        <TemporaryPassword
          value="Temp-Passw0rd"
          recipient="customer"
          logged="This reset has been recorded in the operation log."
        />
        <StatusChangeNotice
          change={{
            target: {
              audience: 'admin',
              id: 'admin-1',
              name: 'Alex Chen',
              email: 'alex@example.com',
            },
            action: 'disable',
            changed: true,
          }}
        />
      </>,
    );

    expect(screen.getByLabelText('Temporary password')).toBeVisible();
    expect(
      screen.getByText('You cannot view this again after closing'),
    ).toBeVisible();
    expect(
      screen.getByText(
        'Disabled administrator Alex Chen; recorded in the operation log',
      ),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the portal password reset confirmation in English', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = await renderWithLocale(
      'en',
      <QueryClientProvider client={client}>
        <ResetPasswordDialog
          target={{
            audience: 'portal',
            id: 'portal-1',
            name: 'Example Telecom',
            email: 'portal@example.com',
          }}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );

    const dialog = screen.getByRole('dialog', {
      name: 'Reset the portal account password?',
    });
    expect(
      screen.getByRole('button', { name: 'Reset password' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(dialog).toHaveTextContent(
      'A new temporary password will be generated. The current password stops working immediately and all sessions on the customer',
    );
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the administrator status confirmation in English', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = await renderWithLocale(
      'en',
      <QueryClientProvider client={client}>
        <AccountStatusDialog
          target={{
            audience: 'admin',
            id: 'admin-1',
            name: 'Alex Chen',
            email: 'alex@example.com',
          }}
          action="disable"
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('dialog', {
        name: 'Disable administrator Alex Chen?',
      }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Disable' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
