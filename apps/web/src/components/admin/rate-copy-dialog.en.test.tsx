import { createRef } from 'react';
import { screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { RateCopyDialog } from './rate-copy-dialog';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const other = {
  id: '00000000-0000-4000-8000-00000000b003',
  code: 'BJH003',
  name: 'Beijing Hualian Information Technology Ltd',
};

function tenantSummary(tenant: { id: string; code: string; name: string }) {
  return {
    ...tenant,
    currency: 'CNY',
    status: 'active',
    health: 'normal',
    settingsConfigured: true,
    balance: '0',
    overdraftLimit: '0',
    availableBalance: '0',
    monthConsumption: '0',
    pendingReceivable: '0',
  };
}

function stubTenants() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          items: [tenantSummary(other)],
          pagination: { page: 1, pageSize: 20, total: 1 },
        }),
      ),
    ),
  );
}

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithLocale(
    'en',
    <QueryClientProvider client={client}>
      <RateCopyDialog
        direction="push"
        self={{
          tenant: {
            id: 'tenant-1',
            code: 'ABC001',
            name: 'Pacific Link Communications Ltd',
            currency: 'CNY',
          },
          versionId: 'version-1',
          entryCount: 2,
          hasScheduled: false,
        }}
        onClose={vi.fn()}
        fallbackFocus={createRef<HTMLElement>()}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rate copy dialog (English)', () => {
  it('renders the tenant picker and overwrite warning without Chinese', async () => {
    stubTenants();
    const { container } = await renderDialog();
    const dialog = screen.getByRole('dialog', {
      name: 'Copy rate table to another tenant',
    });

    expect(dialog).toHaveTextContent(
      'Source: ABC001 Pacific Link Communications Ltd · CNY · 2 rows',
    );
    expect(
      within(dialog).getByRole('list', { name: 'Copy steps' }),
    ).toBeVisible();
    expect(dialog).toHaveTextContent(
      'This will overwrite the entire rate table of the target tenant',
    );
    expect(dialog).toHaveTextContent(
      'The target tenant current rates will be replaced, and prefixes missing from the source will be deleted.',
    );
    expect(
      await within(dialog).findByRole('radio', { name: /BJH003/ }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('radiogroup', { name: 'Target tenant' }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Next: preview changes' }),
    ).toBeEnabled();
    expect(
      within(dialog).getByRole('button', { name: 'Close dialog' }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
