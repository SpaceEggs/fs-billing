const asOf = '2026-09-29T08:30:00.000Z';

/** 截至 asOf 北京日期（2026-09-29）的连续 30 天，`spend` 给出最后几天的消费。 */
export function dailyWindow(spend: Record<string, string> = {}) {
  const last = Date.parse('2026-09-29T00:00:00Z');
  return Array.from({ length: 30 }, (_, index) => {
    const date = new Date(last - (29 - index) * 86400000)
      .toISOString()
      .slice(0, 10);
    return { date, spend: spend[date] ?? '0' };
  });
}

export const recentCall = {
  callUuid: '00000000-0000-4000-8000-0000000000c1',
  startedAt: '2026-09-29T06:03:10.000Z',
  answeredAt: '2026-09-29T06:03:22.000Z',
  endedAt: '2026-09-29T06:07:12.000Z',
  caller: '075586001234',
  callee: '447700900123',
  country: '英国',
  iso: 'GB',
  description: '手机',
  matchedPrefix: '447',
  durationSeconds: 230,
  billedMinutes: '4',
  rate: '0.045',
  charge: '0.18',
  hangupCause: 'NORMAL_CLEARING',
};

/** 门户首页响应：ABC001 透支中（设计稿 1a）。 */
export const homeResponse = {
  currency: 'CNY',
  balance: '-35.2',
  overdraftLimit: '100',
  availableBalance: '64.8',
  health: 'overdraft',
  usage: {
    asOf,
    monthSpend: '2486.3',
    monthCallMinutes: '49726',
    answeredCalls: 12804,
    daily: dailyWindow({ '2026-09-29': '88.64', '2026-09-28': '80' }),
    dailyTotal: '168.64',
  },
  recentCalls: [
    recentCall,
    {
      ...recentCall,
      callUuid: '00000000-0000-4000-8000-0000000000c2',
      startedAt: '2026-09-29T05:57:50.000Z',
      answeredAt: '2026-09-29T05:58:07.000Z',
      endedAt: '2026-09-29T06:10:11.000Z',
      callee: '81312345678',
      country: '日本',
      iso: 'JP',
      description: null,
      durationSeconds: 724,
      billedMinutes: '13',
      charge: '0.46',
    },
  ],
};
