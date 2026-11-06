import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Dialog, DialogContent, DialogTitle } from './dialog';
import { renderWithLocale } from '../../test/i18n';

describe('dialog (English)', () => {
  it('names the close button Close', async () => {
    await renderWithLocale(
      'en',
      <Dialog open>
        <DialogContent>
          <DialogTitle>Example</DialogTitle>
        </DialogContent>
      </Dialog>,
    );

    expect(screen.getByRole('button', { name: 'Close' })).toBeVisible();
  });
});
