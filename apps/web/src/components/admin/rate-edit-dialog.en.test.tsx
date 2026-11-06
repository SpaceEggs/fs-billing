import { createRef } from 'react';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AdminRateEntry } from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import { RateEditDialog } from './rate-edit-dialog';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const entry: AdminRateEntry = {
  prefix: '447',
  iso: 'GB',
  country: 'United Kingdom',
  description: 'Mobile',
  rate: '0.0450',
};

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithLocale(
    'en',
    <QueryClientProvider client={client}>
      <RateEditDialog
        tenant={{ id: 'tenant-1', code: 'ABC001', currency: 'CNY' }}
        baseVersionId="version-1"
        entry={entry}
        hasScheduled={false}
        onClose={vi.fn()}
        onDone={vi.fn()}
        fallbackFocus={createRef<HTMLElement>()}
      />
    </QueryClientProvider>,
  );
}

describe('rate edit dialog (English)', () => {
  it('renders the form and the confirmation step without Chinese', async () => {
    const { container } = await renderDialog();
    const user = userEvent.setup();

    const dialog = screen.getByRole('dialog', { name: 'Edit rate' });
    expect(within(dialog).getByLabelText('Prefix')).toHaveValue('447');
    expect(within(dialog).getByLabelText('ISO')).toHaveValue('GB');
    expect(within(dialog).getByLabelText(/^Country/)).toHaveValue(
      'United Kingdom',
    );
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Mobile');
    const rate = within(dialog).getByLabelText(/Rate \(/);
    expect(rate).toHaveValue('0.0450');
    expect(
      within(dialog).getByText(
        'Current ¥0.0450/min · up to 4 decimal places, cannot be negative',
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole('button', { name: 'Close dialog' }),
    ).toBeVisible();

    await user.clear(rate);
    await user.type(rate, '0.05');
    await user.click(
      within(dialog).getByRole('button', { name: 'Next: confirm' }),
    );

    const confirm = screen.getByRole('dialog', {
      name: 'Confirm rate change',
    });
    expect(within(confirm).getByText('Old rate')).toBeVisible();
    expect(within(confirm).getByText('New rate')).toBeVisible();
    expect(within(confirm).getByText('Unit: ¥/min')).toBeVisible();
    expect(
      within(confirm).getByRole('radio', { name: 'Effective immediately' }),
    ).toBeChecked();
    expect(
      within(confirm).getByRole('button', { name: 'Back to edit' }),
    ).toBeVisible();
    expect(
      within(confirm).getByRole('button', { name: 'Confirm change' }),
    ).toBeVisible();
    expect(
      within(confirm).getByText(
        'New calls are billed at the new rate immediately; existing call details and statements are unaffected. This will be recorded in the operation log.',
      ),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
