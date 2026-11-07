import { screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import { TenantStatusDialog } from './tenant-status-dialog';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const tenant: AdminTenantDetailResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  code: 'ABC001',
  name: 'Example Telecom',
  currency: 'CNY',
  status: 'active',
  health: 'normal',
  settingsConfigured: true,
  balance: '100',
  overdraftLimit: '0',
  availableBalance: '100',
  monthConsumption: '0',
  pendingReceivable: '0',
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: {
    overdraftLimit: '0',
    lowBalanceThreshold: '20',
    emails: [],
  },
  createdAt: '2026-08-12T02:31:02.000Z',
};

describe('tenant status dialog (English)', () => {
  it('explains disabling a tenant without implying calls stop immediately', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = await renderWithLocale(
      'en',
      <QueryClientProvider client={client}>
        <TenantStatusDialog
          tenant={tenant}
          action="disable"
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('dialog', { name: 'Disable tenant ABC001?' }),
    ).toBeVisible();
    expect(
      screen.getByText('Disabling does not guarantee calls stop immediately'),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Disable tenant' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
