import type { CdrFixture } from './db';

/** 话单页 e2e 的费率表：447 带说明「手机」，44 没有说明。 */
export const cdrRates = [
  { prefix: '86', iso: 'CN', country: '中国', description: '', rate: '0.0500' },
  { prefix: '44', iso: 'GB', country: '英国', description: '', rate: '0.0200' },
  {
    prefix: '447',
    iso: 'GB',
    country: '英国',
    description: '手机',
    rate: '0.0450',
  },
  {
    prefix: '1876',
    iso: 'JM',
    country: '牙买加',
    description: '',
    rate: '0.2500',
  },
];

const answered = (
  startedAt: string,
  seconds: number,
  fields: Pick<
    CdrFixture,
    | 'callee'
    | 'billingNumber'
    | 'country'
    | 'iso'
    | 'description'
    | 'prefix'
    | 'rate'
    | 'minutes'
    | 'charge'
  > &
    Partial<Pick<CdrFixture, 'unverified' | 'caller'>>,
): CdrFixture => {
  const started = new Date(startedAt);
  const answeredAt = new Date(started.getTime() + 5000);
  return {
    startedAt: started.toISOString(),
    answeredAt: answeredAt.toISOString(),
    endedAt: new Date(answeredAt.getTime() + seconds * 1000).toISOString(),
    caller: '075586001234',
    durationSeconds: seconds,
    hangupCause: 'NORMAL_CLEARING',
    unverified: false,
    ...fields,
  };
};

/** 北京时间 2026-09-29 00:30:05 接通（UTC 2026-09-28 16:30:05），英国手机，4 分钟。 */
export const callAtUtcBoundary = answered('2026-09-28T16:30:00Z', 230, {
  callee: '+447700900123',
  billingNumber: '447700900123',
  country: '英国',
  iso: 'GB',
  description: '手机',
  prefix: '447',
  rate: '0.0450',
  minutes: '4',
  charge: '0.18',
});

export const landlineCall = answered('2026-09-15T02:00:00Z', 60, {
  callee: '00442071234567',
  billingNumber: '442071234567',
  country: '英国',
  iso: 'GB',
  description: null,
  prefix: '44',
  rate: '0.0200',
  minutes: '1',
  charge: '0.02',
});

export const unverifiedCall = answered('2026-09-20T03:00:00Z', 780, {
  callee: '18765551234',
  billingNumber: '18765551234',
  country: '牙买加',
  iso: 'JM',
  description: null,
  prefix: '1876',
  rate: '0.2500',
  minutes: '13',
  charge: '3.25',
  unverified: true,
});

export const chinaCall = answered('2026-09-10T02:00:00Z', 90, {
  callee: '8613800138000',
  billingNumber: '8613800138000',
  country: '中国',
  iso: 'CN',
  description: null,
  prefix: '86',
  rate: '0.0500',
  minutes: '2',
  charge: '0.10',
});

export const unansweredCall: CdrFixture = {
  startedAt: '2026-09-20T04:00:00.000Z',
  answeredAt: null,
  endedAt: '2026-09-20T04:00:20.000Z',
  caller: '075586001234',
  callee: '8613900139000',
  billingNumber: '8613900139000',
  country: null,
  iso: null,
  description: null,
  prefix: null,
  rate: null,
  durationSeconds: 0,
  minutes: '0',
  charge: '0',
  hangupCause: 'CALL_REJECTED',
  unverified: false,
};

/** 凑满第二页：50 通中国话单，北京时间 2026-09-05 上午。 */
export const fillerCalls = Array.from({ length: 50 }, (_, index) =>
  answered(`2026-09-05T01:${String(index).padStart(2, '0')}:00Z`, 30, {
    callee: `861380000${String(1000 + index)}`,
    billingNumber: `861380000${String(1000 + index)}`,
    country: '中国',
    iso: 'CN',
    description: null,
    prefix: '86',
    rate: '0.0500',
    minutes: '1',
    charge: '0.05',
  }),
);

/** 5 通有名有姓的话单加 50 通填充：已接通 54 通，未接通 1 通，其中一通未经验证。 */
export const cdrFixture = [
  callAtUtcBoundary,
  landlineCall,
  unverifiedCall,
  chinaCall,
  unansweredCall,
  ...fillerCalls,
];
export const answeredCount = cdrFixture.filter((cdr) => cdr.answeredAt).length;

export const septemberRange = 'from=2026-09-01&to=2026-09-30';
