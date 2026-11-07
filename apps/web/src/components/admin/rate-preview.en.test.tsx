import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { PreviewChanges, type RatePreview } from './rate-preview';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const preview = {
  ok: true,
  previewId: '00000000-0000-4000-8000-0000000000cc',
  expiresAt: '2026-10-15T14:00:00.000Z',
  currency: 'CNY',
  encoding: 'UTF-8',
  counts: { added: 1, modified: 1, deleted: 1 },
  changes: [
    {
      kind: 'added',
      after: {
        iso: '',
        description: '',
        prefix: '33',
        country: 'France',
        rate: '0.0600',
      },
    },
    {
      kind: 'modified',
      before: {
        iso: '',
        description: '',
        prefix: '86',
        country: 'China',
        rate: '0.0450',
      },
      after: {
        iso: '',
        description: '',
        prefix: '86',
        country: 'China',
        rate: '0.0500',
      },
    },
    {
      kind: 'deleted',
      before: {
        iso: 'JM',
        description: 'Mobile',
        prefix: '1876',
        country: 'Jamaica',
        rate: '0.3000',
      },
    },
  ],
} as RatePreview;

const labels = {
  verified: 'Validation passed.',
  summary: 'This will',
  confirm: 'Confirm import',
  busy: 'Importing…',
  networkMessage:
    'Cannot confirm whether the import was applied. Check the rate table before trying again.',
  uncertainNote:
    'The result of the previous confirmation is unknown. Confirming again will not import twice.',
};

function renderPreview() {
  return renderWithLocale(
    'en',
    <PreviewChanges
      preview={preview}
      unchanged={1}
      schedule={{ kind: 'immediate' }}
      labels={labels}
      error={null}
      uncertain={false}
      busy={false}
      onBack={vi.fn()}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
}

describe('rate preview (English)', () => {
  it('renders counts, the delete warning and the effective time in English', async () => {
    const { container } = await renderPreview();

    expect(screen.getByText('Validation passed.')).toBeVisible();
    expect(container).toHaveTextContent(
      'This will add 1 and modify 1 and delete 1; 1 unchanged',
    );
    expect(container).toHaveTextContent(
      'After deletion, calls to these prefixes will be rejected: 1876 Jamaica · Mobile',
    );
    expect(screen.getByText('Effective from')).toBeVisible();
    expect(screen.getByText('Effective immediately')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Back' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Confirm import' }),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('shows the empty state without Chinese', async () => {
    const { container } = await renderWithLocale(
      'en',
      <PreviewChanges
        preview={{
          ...preview,
          counts: { added: 0, modified: 0, deleted: 0 },
          changes: [],
        }}
        unchanged={2}
        schedule={{
          kind: 'scheduled',
          effectiveFrom: '2026-10-20T00:00:00+08:00',
        }}
        labels={labels}
        error={null}
        uncertain={false}
        busy={false}
        onBack={vi.fn()}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(
      screen.getByText('No changes from the current rate table.'),
    ).toBeVisible();
    expect(
      screen.getByText('From 20 Oct 2026 00:00:00 (Beijing time, UTC+8)'),
    ).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
