import { screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { AdminRateVersion } from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import {
  CancelScheduledDialog,
  ScheduledRateVersion,
} from './scheduled-rate-version';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const version = (id: string, effectiveFrom: string): AdminRateVersion => ({
  id,
  effectiveFrom,
  entries: [],
});

describe('scheduled rate version (English)', () => {
  it('renders the effective time, change counts and actions', async () => {
    const { container } = await renderWithLocale(
      'en',
      <ScheduledRateVersion
        version={version(
          '00000000-0000-4000-8000-00000000000b',
          '2026-10-30T02:00:00.000Z',
        )}
        previous={version(
          '00000000-0000-4000-8000-00000000000a',
          '2026-09-30T02:00:00.000Z',
        )}
        currency="CNY"
        exporting={false}
        onExport={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByText('Scheduled new version')).toBeVisible();
    expect(container).toHaveTextContent(
      'Effective from 30 Oct 2026 10:00:00 · Added 0 · Modified 0 · Deleted 0',
    );
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Cancel schedule' }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('asks for confirmation before canceling the scheduled version', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = await renderWithLocale(
      'en',
      <QueryClientProvider client={client}>
        <CancelScheduledDialog
          tenantId="00000000-0000-4000-8000-000000000001"
          version={version(
            '00000000-0000-4000-8000-00000000000b',
            '2026-10-30T02:00:00.000Z',
          )}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('dialog', {
        name: 'Cancel the scheduled new version?',
      }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Cancel schedule' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Keep schedule' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
