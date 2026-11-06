import { screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';
import { figures } from '../../test/statements';
import { renderWithLocale } from '../../test/i18n';
import { StatementList } from './statement-list';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

async function renderList() {
  const rootRoute = createRootRoute({
    component: () => (
      <StatementList
        currency="CNY"
        rows={[{ month: '2026-08', state: 'final', figures: figures() }]}
      />
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  return renderWithLocale('en', <RouterProvider router={router} />);
}

describe('StatementList (English)', () => {
  it('shows English headers, month and labels without Chinese', async () => {
    const { container } = await renderList();

    await screen.findAllByText('Month');
    for (const header of [
      'Month',
      'Opening balance',
      'Recharge',
      'Gift',
      'Adjustment',
      'Call charges',
      'Closing balance',
      'Call minutes',
    ])
      expect(screen.getAllByText(header).length).toBeGreaterThan(0);

    expect(screen.getAllByText('Aug 2026').length).toBeGreaterThan(0);
    expect(container).not.toHaveTextContent(HAN);
  });
});
