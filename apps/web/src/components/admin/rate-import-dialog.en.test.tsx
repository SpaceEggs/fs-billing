import { createRef } from 'react';
import { screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { RateImportDialog } from './rate-import-dialog';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderWithLocale(
    'en',
    <QueryClientProvider client={client}>
      <RateImportDialog
        tenant={{
          id: 'tenant-1',
          code: 'ABC001',
          name: 'Pacific Link Communications Ltd',
          currency: 'CNY',
        }}
        base={{ versionId: 'version-1', entryCount: 2, hasScheduled: false }}
        onClose={vi.fn()}
        fallbackFocus={createRef<HTMLElement>()}
      />
    </QueryClientProvider>,
  );
}

describe('rate import dialog (English)', () => {
  it('renders the upload step and both schedule options without Chinese', async () => {
    const { container } = await renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Import rate table' });

    expect(
      within(dialog).getByRole('list', { name: 'Import steps' }),
    ).toBeVisible();
    expect(
      within(dialog)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['1Upload', '2Preview and validate', '3Confirm import']);
    expect(
      within(dialog).getByRole('button', { name: 'Download CSV template' }),
    ).toBeVisible();
    expect(dialog).toHaveTextContent(
      'Format: ISO,Country,Destination Prefix,Description,Rate',
    );
    expect(dialog).toHaveTextContent(
      'One prefix per row; replaces the entire rate table',
    );
    expect(dialog).toHaveTextContent(
      'The description is visible to customers; do not enter internal notes',
    );
    expect(
      within(dialog).getByLabelText('Choose CSV file'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole('radio', { name: 'Effective immediately' }),
    ).toHaveAccessibleDescription(
      'Used for new calls right after the import is confirmed',
    );
    expect(
      within(dialog).getByRole('radio', { name: 'Effective at a set time' }),
    ).toHaveAccessibleDescription('The current rate stays in use until then');
    expect(
      within(dialog).getByRole('button', { name: 'Next: preview' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: 'Close dialog' }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
