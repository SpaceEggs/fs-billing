import { describe, expect, it } from 'vitest';
import { answeredCdr, unansweredCdr } from '../../test/cdr';
import type { PortalCdr } from '@fs-billing/shared';
import {
  cdrCountryLabel,
  cdrHangupCause,
  cdrMoment,
  cdrShortMoment,
  formatMinutes,
} from './cdr-format';
import { unansweredNote } from './cdr-summary';

const answered = answeredCdr() as PortalCdr;
const unanswered = unansweredCdr() as PortalCdr;

describe('cdrCountryLabel', () => {
  it('joins the country and the description', () => {
    expect(cdrCountryLabel(answered)).toBe('英国 · 手机');
  });

  it.each([null, '', '  '])(
    'shows only the country for the description %j',
    (description) =>
      expect(cdrCountryLabel({ ...answered, description })).toBe('英国'),
  );

  it('writes 未接通 for a call without a country, like the CSV', () => {
    expect(cdrCountryLabel(unanswered)).toBe('未接通');
  });
});

describe('cdrMoment', () => {
  it('uses the answer time, or the ring start for an unanswered call', () => {
    expect(cdrMoment(answered)).toBe(answered.answeredAt);
    expect(cdrMoment(unanswered)).toBe(unanswered.startedAt);
  });

  it('shows the Beijing time of the UTC 16:30 call as 00:30 the next day', () => {
    expect(
      cdrShortMoment({
        ...answered,
        answeredAt: '2026-09-28T16:30:00.000Z',
      }),
    ).toBe('09-29 00:30:00');
  });
});

describe('formatMinutes', () => {
  it('rounds to whole minutes with thousands separators', () => {
    expect(formatMinutes('49726')).toBe('49,726分钟');
    expect(formatMinutes('0')).toBe('0分钟');
    expect(formatMinutes('4.0')).toBe('4分钟');
  });
});

describe('cdrHangupCause', () => {
  it('translates a known cause and keeps an unknown or empty one', () => {
    expect(cdrHangupCause(answered)).toBe('NORMAL_CLEARING（正常挂断）');
    expect(cdrHangupCause({ ...answered, hangupCause: 'SOMETHING_NEW' })).toBe(
      'SOMETHING_NEW',
    );
    expect(cdrHangupCause({ ...answered, hangupCause: '' })).toBe('—');
  });
});

describe('unansweredNote', () => {
  it('says how many unanswered calls the answered view hides (decision 37)', () => {
    expect(unansweredNote('answered', 713)).toBe('另有未接通 713 通');
    expect(unansweredNote('answered', 0)).toBeNull();
  });

  it('counts the unanswered calls inside the all view', () => {
    expect(unansweredNote('all', 713)).toBe('含未接通 713');
    expect(unansweredNote('all', 0)).toBe('全部已接通');
  });
});
