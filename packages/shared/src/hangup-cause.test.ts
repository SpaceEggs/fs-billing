import { describe, expect, it } from 'vitest';
import {
  HANGUP_CAUSE_LABELS,
  formatHangupCause,
  hangupCauseLabel,
} from './hangup-cause.js';

describe('formatHangupCause', () => {
  it.each([
    ['NORMAL_CLEARING', 'NORMAL_CLEARING（正常挂断）'],
    ['USER_BUSY', 'USER_BUSY（被叫忙）'],
    ['NO_ANSWER', 'NO_ANSWER（无人应答）'],
    ['CALL_REJECTED', 'CALL_REJECTED（被叫拒接）'],
    ['UNALLOCATED_NUMBER', 'UNALLOCATED_NUMBER（空号）'],
    ['NORMAL_TEMPORARY_FAILURE', 'NORMAL_TEMPORARY_FAILURE（临时故障）'],
  ])('shows %s with its Chinese name', (cause, shown) => {
    expect(formatHangupCause(cause)).toBe(shown);
  });

  it('shows an unknown cause as the English original only', () => {
    expect(formatHangupCause('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(hangupCauseLabel('SOMETHING_NEW')).toBeUndefined();
  });

  it('does not match inherited object keys or other spellings', () => {
    expect(formatHangupCause('constructor')).toBe('constructor');
    expect(formatHangupCause('toString')).toBe('toString');
    expect(formatHangupCause('normal_clearing')).toBe('normal_clearing');
  });

  it('trims whitespace and keeps the stored empty default empty', () => {
    expect(formatHangupCause(' USER_BUSY ')).toBe('USER_BUSY（被叫忙）');
    expect(formatHangupCause('')).toBe('');
  });
});

describe('HANGUP_CAUSE_LABELS', () => {
  it('has a nonempty Chinese name for every FreeSWITCH cause name', () => {
    for (const [cause, label] of Object.entries(HANGUP_CAUSE_LABELS)) {
      expect(cause).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(label).toMatch(/\p{Script=Han}/u);
      expect(label).not.toContain('（');
    }
  });
});
