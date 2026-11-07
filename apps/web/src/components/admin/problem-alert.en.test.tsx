import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithLocale } from '../../test/i18n';
import { ApiRequestError } from '../../lib/api';
import { ProblemAlert, RequestFailure } from './problem-alert';

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const failure = (status: number, code: string) =>
  new ApiRequestError(status, {
    error: { code, message: 'server message', requestId: 'req-test' },
  } as never);

describe('problem alert (English)', () => {
  it('reports a network interruption and offers a refresh button', async () => {
    const onRefresh = vi.fn();
    const { container } = await renderWithLocale(
      'en',
      <ProblemAlert
        error={new ApiRequestError(0, null)}
        onRefresh={onRefresh}
      />,
    );

    expect(screen.getByText('Network interrupted')).toBeVisible();
    expect(screen.getByText('Check your network and try again')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('uses the catalog text and refresh action for a missing resource', async () => {
    const onRefresh = vi.fn();
    const { container } = await renderWithLocale(
      'en',
      <ProblemAlert error={failure(404, 'NOT_FOUND')} onRefresh={onRefresh} />,
    );

    expect(
      screen.getByText('The content does not exist or has been deleted'),
    ).toBeVisible();
    expect(screen.getByText('Refresh and try again')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });

  it('lists validation details through RequestFailure', async () => {
    const { container } = await renderWithLocale(
      'en',
      <RequestFailure
        error={
          new ApiRequestError(400, {
            error: {
              code: 'VALIDATION_ERROR',
              message: 'server message',
              requestId: 'req-test',
              issues: [
                {
                  path: ['amount'],
                  message: 'server message',
                  key: 'admin:balance.amountRequired',
                },
              ],
            },
          } as never)
        }
      />,
    );

    expect(
      screen.getByText(
        'The submission is invalid. Check the highlighted fields',
      ),
    ).toBeVisible();
    expect(screen.getByText('Enter an amount')).toBeVisible();
    expect(container).not.toHaveTextContent(HAN);
  });
});
