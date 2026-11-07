import { afterEach, describe, expect, it } from 'vitest';
import { translate } from '@fs-billing/shared';
import { i18n } from '../i18n';
import { ApiRequestError } from './api';
import type { Translator } from './api-problem';
import { apiProblem, problemNotice } from './api-problem';

const t: Translator = (key, params) => translate('en', key, params);

const failure = (status: number, code: string, extra: object = {}) =>
  new ApiRequestError(status, {
    error: { code, message: 'server message', requestId: 'req', ...extra },
  } as never);

afterEach(async () => {
  await i18n.changeLanguage('zh');
});

describe('problem notices (English)', () => {
  it('uses the fallback title and body for unavailable failures', () => {
    expect(problemNotice({ kind: 'unavailable' }, t)).toEqual({
      title: 'Service temporarily unavailable',
      body: 'Try again later',
      refresh: false,
    });
  });

  it('translates rate limits, conflicts and missing content', async () => {
    expect(
      problemNotice({ kind: 'rate-limited', retryAfterSeconds: 12 }, t),
    ).toEqual({
      title: 'Too many requests',
      body: 'Try again in 12 seconds',
      refresh: false,
    });
    await i18n.changeLanguage('en');
    expect(
      problemNotice(apiProblem(failure(409, 'SETTLEMENT_CONFLICT')), t),
    ).toEqual({
      title: 'The settlement status changed. Refresh and confirm again',
      refresh: true,
    });
    expect(problemNotice({ kind: 'not-found' }, t)).toEqual({
      title: 'The content does not exist or has been deleted',
      body: 'Refresh and try again',
      refresh: true,
    });
  });

  it('translates CSV row errors and validation details', () => {
    expect(
      problemNotice(
        {
          kind: 'csv-invalid',
          rows: [
            {
              line: 2,
              key: 'errors:csv.row.prefixDigits',
              params: { prefix: '8a6' },
            },
          ],
        },
        t,
      ),
    ).toEqual({
      title: 'CSV has 1 row errors. Fix them and upload again',
      refresh: false,
    });

    expect(
      problemNotice(
        {
          kind: 'validation',
          issues: [
            {
              path: ['emails'],
              key: 'admin:tenant.create.maxRecipients',
              params: { max: 20 },
              message: '',
            },
          ],
        },
        t,
      ),
    ).toEqual({
      title: 'The submission is invalid. Check the highlighted fields',
      details: ['At most 20 notification recipients'],
      refresh: false,
    });
  });
});
