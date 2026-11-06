import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PortalCdr } from '@fs-billing/shared';
import { answeredCdr } from '../../test/cdr';
import { renderWithLocale } from '../../test/i18n';
import { CdrDetailDialog } from './cdr-detail';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const cdr = answeredCdr(1, {
  country: 'United Kingdom',
  description: 'Mobile',
}) as PortalCdr;

describe('CdrDetailDialog (English)', () => {
  it('shows English detail labels and the hangup cause', async () => {
    const { container } = await renderWithLocale(
      'en',
      <CdrDetailDialog cdr={cdr} currency="CNY" onClose={vi.fn()} />,
    );

    expect(screen.getByRole('dialog', { name: 'Call details' })).toBeVisible();
    for (const label of [
      'Direction',
      'Caller number',
      'Callee number',
      'Country',
      'Matched prefix',
      'Ring start',
      'Answer time',
      'End time',
      'Duration',
      'Billed minutes',
      'Rate',
      'Hangup cause',
      'Call UUID',
    ])
      expect(screen.getByText(label)).toBeInTheDocument();

    expect(
      screen.getByText('NORMAL_CLEARING (Normal clearing)'),
    ).toBeInTheDocument();
    expect(container).not.toHaveTextContent(HAN);
  });
});
