import { screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type {
  AdminStatementRegenerateResponse,
  AdminStatementVersionFigures,
} from '@fs-billing/shared';
import { renderWithLocale } from '../../test/i18n';
import { RegenerateDialog, RegenerateNotice } from './statement-regenerate';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const figures = (
  version: number,
  over: Partial<AdminStatementVersionFigures> = {},
): AdminStatementVersionFigures => ({
  openingBalance: '0',
  recharge: '0',
  gift: '0',
  adjustment: '0',
  callCharges: '1.0000',
  closingBalance: '-1.0000',
  calls: 1,
  callMinutes: '1',
  version,
  ...over,
});

describe('statement regenerate (English)', () => {
  it('renders the confirmation dialog without Chinese', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { container } = await renderWithLocale(
      'en',
      <QueryClientProvider client={client}>
        <RegenerateDialog
          target={{
            tenantId: '00000000-0000-4000-8000-000000000003',
            tenantCode: 'ABC001',
            currency: 'CNY',
            month: '2026-09',
            version: 1,
            current: {
              callCharges: '12.3400',
              callMinutes: '65',
              closingBalance: '-12.3400',
              generatedAt: '2026-10-15T01:03:27.120Z',
            },
          }}
          onClose={vi.fn()}
          onDone={vi.fn()}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole('dialog', {
        name: 'Regenerate the ABC001 Sep 2026 statement?',
      }),
    ).toBeVisible();
    expect(screen.getByText('Current call charges')).toBeVisible();
    expect(screen.getByText(/65 min/)).toBeVisible();
    expect(screen.getByText('15 Oct 2026 09:03:27')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('reports a newly created statement', async () => {
    const result: AdminStatementRegenerateResponse = {
      auditId: '00000000-0000-4000-8000-000000000004',
      month: '2026-09',
      created: true,
      changed: true,
      before: null,
      after: figures(1),
      staleFollowingMonths: [],
    };
    const { container } = await renderWithLocale(
      'en',
      <RegenerateNotice
        outcome={{
          tenantId: '00000000-0000-4000-8000-000000000003',
          tenantCode: 'ABC001',
          currency: 'CNY',
          result,
        }}
        onDismiss={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        'Generated the ABC001 Sep 2026 statement (version 1); recorded in the operation log.',
      ),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
