import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { GenerationNotes, RegenerateButton } from './statement-parts';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('statement parts (English)', () => {
  it('shows the original generation time as DD MMM YYYY HH:mm', async () => {
    const { container } = await renderWithLocale(
      'en',
      <GenerationNotes
        reconcileStatus="stale"
        version={2}
        generatedAt="2026-10-15T01:03:27.120Z"
        firstGeneratedAt="2026-10-10T01:03:27.120Z"
        detailsDeleted
      />,
    );

    expect(screen.getByText('Statement is stale')).toBeVisible();
    expect(
      screen.getByText('Regenerated · original 10 Oct 2026 09:03:27'),
    ).toBeVisible();
    expect(
      screen.getByText('Call details for this month were deleted'),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('renders the regenerate button and its disabled reason', async () => {
    const { container } = await renderWithLocale(
      'en',
      <RegenerateButton
        allowed={false}
        reason="details_deleted"
        label="Regenerate ABC001 Aug 2026"
        onClick={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', {
      name: 'Regenerate ABC001 Aug 2026',
    });
    expect(button).toHaveTextContent('Regenerate');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'Call details deleted; cannot be recalculated',
    );
    expect(container).not.toHaveTextContent(HAN);
  });
});
