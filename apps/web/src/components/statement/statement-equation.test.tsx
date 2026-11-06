import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { figures } from '../../test/statements';
import { renderWithLocale } from '../../test/i18n';
import { StatementEquation } from './statement-equation';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

describe('StatementEquation (English)', () => {
  it('shows English term labels and the usage note', async () => {
    const { container } = await renderWithLocale(
      'en',
      <StatementEquation currency="CNY" figures={figures()} />,
    );

    for (const label of [
      'Opening balance',
      'Recharge',
      'Gift',
      'Adjustment',
      'Call charges',
      'Closing balance',
    ])
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);

    expect(screen.getAllByText('9,642 calls · 37,468 min')[0]).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
