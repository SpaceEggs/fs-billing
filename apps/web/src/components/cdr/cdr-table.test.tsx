import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PortalCdr } from '@fs-billing/shared';
import { answeredCdr } from '../../test/cdr';
import { renderWithLocale } from '../../test/i18n';
import { CdrTable } from './cdr-table';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const cdr = answeredCdr(1, {
  country: 'United Kingdom',
  description: 'Mobile',
}) as PortalCdr;

describe('CdrTable (English)', () => {
  it('shows English headers and row labels without Chinese', async () => {
    const { container } = await renderWithLocale(
      'en',
      <CdrTable currency="CNY" items={[cdr]} onSelect={() => {}} />,
    );

    for (const header of [
      'Answer time ↓',
      'Caller number',
      'Callee number',
      'Direction',
      'Country',
      'Duration',
      'Billed minutes',
      'Rate (¥/min)',
      'Charge',
    ])
      expect(screen.getByText(header)).toBeInTheDocument();

    expect(screen.getByText('Outbound')).toBeInTheDocument();
    expect(screen.getByText('United Kingdom · Mobile')).toBeInTheDocument();
    expect(container).not.toHaveTextContent(HAN);
  });
});
