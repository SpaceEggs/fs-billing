import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AdminTenantDetailResponse } from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import { BalanceDialog } from './balance-dialog';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const tenant: AdminTenantDetailResponse = {
  id: '00000000-0000-4000-8000-000000000002',
  code: 'ABC001',
  name: 'Example Telecom',
  currency: 'CNY',
  status: 'active',
  health: 'normal',
  settingsConfigured: true,
  balance: '100',
  overdraftLimit: '100',
  availableBalance: '200',
  monthConsumption: '0',
  pendingReceivable: '0',
  contactName: '',
  contactPhone: '',
  remark: '',
  settings: {
    overdraftLimit: '100',
    lowBalanceThreshold: '20',
    emails: [],
  },
  createdAt: '2026-08-12T02:31:02.000Z',
};

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithLocale(
    'en',
    <QueryClientProvider client={client}>
      <BalanceDialog
        owner="profile-admin-1"
        tenant={tenant}
        open
        onOpenChange={vi.fn()}
        onViewLedger={vi.fn()}
        thresholds={{ CNY: '10000', USD: '1500' }}
      />
    </QueryClientProvider>,
  );
}

describe('balance dialog (English)', () => {
  it('names all four operation types and reports a validation error', async () => {
    const user = userEvent.setup();
    const { container } = await renderDialog();

    const dialog = screen.getByRole('dialog', { name: 'Balance operation' });
    const group = within(dialog).getByRole('tablist', {
      name: 'Operation type',
    });
    expect(
      within(group)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Recharge', 'Credit recharge', 'Gift', 'Adjustment']);

    await user.click(within(dialog).getByRole('button', { name: 'Next' }));
    expect(within(dialog).getByText('Enter an amount')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
