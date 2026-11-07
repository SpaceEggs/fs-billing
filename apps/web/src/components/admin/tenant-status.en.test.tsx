import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { healthOptionsFor, TenantStatus } from './tenant-status';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('tenant status (English)', () => {
  it('renders the health label and the missing-settings marker', async () => {
    const { container } = await renderWithLocale(
      'en',
      <TenantStatus health="suspended" settingsConfigured={false} />,
    );

    expect(screen.getByText('Suspended')).toBeVisible();
    expect(screen.getByText('Alerts not configured')).toBeVisible();
    expect(healthOptionsFor('en').map((option) => option.label)).toEqual([
      'Suspended',
      'Overdrawn',
      'Low balance',
      'Normal',
      'Disabled',
    ]);
    expect(container).not.toHaveTextContent(HAN);
  });
});
