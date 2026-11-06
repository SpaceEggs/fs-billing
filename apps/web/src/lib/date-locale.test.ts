import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { previousBeijingMonth } from './admin-statements';
import { scheduledRowHints } from './rates';

const uk = {
  prefix: '447',
  iso: '',
  country: '英国手机',
  description: '',
  rate: '0.0450',
};

function changedDateResults() {
  return {
    previousMonth: previousBeijingMonth(new Date('2026-09-30T17:00:00.000Z')),
    hints: scheduledRowHints([uk], {
      effectiveFrom: '2026-10-01T00:00:00+08:00',
      entries: [{ ...uk, rate: '0.0480' }],
    }),
  };
}

describe('language-independent date calculations', () => {
  it('returns the same results under en and zh', async () => {
    await i18n.changeLanguage('zh');
    const zh = changedDateResults();
    await i18n.changeLanguage('en');
    const en = changedDateResults();
    expect(en).toEqual(zh);
  });
});
