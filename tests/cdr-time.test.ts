import { describe, expect, it } from 'vitest';
import {
  findRate,
  parseDialedNumber,
  rate,
} from '../packages/rating/src/index.js';
import { modJsonCdrSchema } from '../packages/shared/src/worker.js';

const second = Date.parse('2026-10-12T02:00:09Z') / 1000;
const variables = {
  billing_dialed_number: '+447700900123',
  uuid: '7f1c2a9e-0d3b-4c5e-8a6f-1b2c3d4e5f60',
  start_epoch: second - 9,
  answer_epoch: second,
  end_epoch: second + 60,
  billsec: 59,
  duration: 69,
};

describe('CDR timestamp precision', () => {
  it('keeps an unanswered call with zero answer microseconds uncharged', () => {
    const cdr = modJsonCdrSchema.parse({
      variables: {
        ...variables,
        answer_epoch: 0,
        answer_uepoch: 0,
        billsec: 0,
      },
    });
    expect(cdr.answeredAt).toBe(null);
    expect(cdr.billsec).toBe(0);
  });

  it('accepts answer microseconds when the optional second epoch is absent', () => {
    const cdr = modJsonCdrSchema.parse({
      variables: {
        ...variables,
        answer_epoch: undefined,
        answer_uepoch: second * 1e6 + 900123,
      },
    });
    expect(cdr.answeredAt?.toISOString()).toBe('2026-10-12T02:00:09.900Z');
  });

  it('rates a .900 answer using the rate effective at .500 in the same second', () => {
    const cdr = modJsonCdrSchema.parse({
      variables: { ...variables, answer_uepoch: `${second * 1e6 + 900123}` },
    });
    const dialed = parseDialedNumber('447700900123');
    if (!dialed || !cdr.answeredAt) throw new Error('Invalid fixture');
    const result = findRate(
      {
        currency: 'CNY',
        versions: [
          {
            effectiveFrom: new Date(second * 1000),
            entries: [
              {
                iso: '',
                description: '',
                prefix: '447',
                country: 'UK',
                perMinute: rate('CNY', '0.1'),
              },
            ],
          },
          {
            effectiveFrom: new Date(second * 1000 + 500),
            entries: [
              {
                iso: '',
                description: '',
                prefix: '447',
                country: 'UK',
                perMinute: rate('CNY', '0.2'),
              },
            ],
          },
        ],
      },
      dialed,
      cdr.answeredAt,
    );
    expect(result?.perMinute.perMinute.toFixed()).toBe('0.2');
    expect(cdr.answeredAt.toISOString()).toBe('2026-10-12T02:00:09.900Z');
  });

  it('preserves start and end milliseconds and falls back only when microseconds are absent', () => {
    const cdr = modJsonCdrSchema.parse({
      variables: {
        ...variables,
        start_uepoch: (second - 9) * 1e6 + 100999,
        end_uepoch: (second + 60) * 1e6 + 200999,
      },
    });
    expect(cdr.startedAt.toISOString()).toBe('2026-10-12T02:00:00.100Z');
    expect(cdr.answeredAt?.toISOString()).toBe('2026-10-12T02:00:09.000Z');
    expect(cdr.endedAt.toISOString()).toBe('2026-10-12T02:01:09.200Z');
  });

  it.each(['', '-1', '1.5', '9007199254740992', 'bad', null])(
    'rejects invalid microseconds %j instead of falling back to seconds',
    (answer_uepoch) => {
      expect(
        modJsonCdrSchema.safeParse({
          variables: { ...variables, answer_uepoch },
        }).success,
      ).toBe(false);
    },
  );

  it('rejects disagreement between second and microsecond epochs', () => {
    expect(
      modJsonCdrSchema.safeParse({
        variables: { ...variables, answer_uepoch: (second + 1) * 1e6 },
      }).success,
    ).toBe(false);
  });

  it('rejects an answer after the end within the same second', () => {
    expect(
      modJsonCdrSchema.safeParse({
        variables: {
          ...variables,
          end_epoch: second,
          end_uepoch: second * 1e6 + 500000,
          answer_uepoch: second * 1e6 + 900000,
          duration: 9,
          billsec: 0,
        },
      }).success,
    ).toBe(false);
  });
});
