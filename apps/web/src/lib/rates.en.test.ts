import { describe, expect, it } from 'vitest';
import { DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS } from '@fs-billing/shared';
import { ApiRequestError } from './api';
import {
  cancelFailureMessage,
  resolveSchedule,
  scheduledRowHints,
  validateRateEdit,
} from './rates';

const failure = (status: number, code: string) =>
  new ApiRequestError(status, {
    error: { code, message: 'server message', requestId: 'req' },
  } as never);

const entry = {
  prefix: '447',
  iso: 'GB',
  country: 'United Kingdom',
  description: 'Mobile',
  rate: '0.0450',
};

describe('rate helpers (English)', () => {
  it('validates an edited rate in English', () => {
    expect(validateRateEdit(entry, { ...entry, iso: 'GBR' }, 'en')).toEqual({
      errors: { iso: 'ISO must be two letters or empty' },
    });
    expect(
      validateRateEdit(entry, { ...entry, country: '', rate: '0.05' }, 'en'),
    ).toEqual({ errors: { country: 'Enter the country' } });
    expect(validateRateEdit(entry, { ...entry, rate: '0.045' }, 'en')).toEqual({
      errors: { rate: 'The new rate is the same as the current rate' },
    });
    expect(validateRateEdit(entry, { ...entry, rate: '-0.01' }, 'en')).toEqual({
      errors: { rate: 'Rate cannot be negative' },
    });
  });

  it('describes schedule bounds in English', () => {
    const horizon = DEFAULT_ADMIN_RATE_SCHEDULE_HORIZON_MS;
    const now = Date.parse('2026-10-16T01:02:00Z');
    expect(
      resolveSchedule({ kind: 'scheduled', minute: '' }, now, horizon, 'en'),
    ).toEqual({ error: 'Choose the effective time' });
    expect(
      resolveSchedule(
        { kind: 'scheduled', minute: '2026-10-16T09:01' },
        now,
        horizon,
        'en',
      ),
    ).toEqual({ error: 'Effective time must be later than now' });
    expect(
      resolveSchedule(
        { kind: 'scheduled', minute: '2027-10-16T09:03' },
        now,
        horizon,
        'en',
      ),
    ).toEqual({
      error: 'Effective time must not be later than 16 Oct 2027 09:02:00',
    });
  });

  it('writes scheduled row hints and cancellation messages in English', () => {
    expect(
      scheduledRowHints(
        [entry],
        {
          effectiveFrom: '2026-10-01T00:00:00+08:00',
          entries: [{ ...entry, rate: '0.0480' }],
        },
        'en',
      ).get('447'),
    ).toBe('From 01 Oct: 0.0480');
    expect(
      scheduledRowHints(
        [entry],
        { effectiveFrom: '2026-10-01T00:00:00+08:00', entries: [] },
        'en',
      ).get('447'),
    ).toBe('From 01 Oct: delete');
    expect(
      cancelFailureMessage(failure(409, 'RATE_VERSION_CONFLICT'), 'en'),
    ).toBe(
      'This version is already effective or about to take effect and cannot be cancelled; the rate table may also have been modified. Refresh to check.',
    );
    expect(cancelFailureMessage(failure(404, 'NOT_FOUND'), 'en')).toBe(
      'This scheduled version no longer exists and may have been cancelled. Refresh to check.',
    );
  });
});
