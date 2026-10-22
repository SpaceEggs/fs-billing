import type {
  PortalStatementResponse,
  PortalStatementsResponse,
} from '@fs-billing/shared';

/** 月账单设计稿（客户门户第二批）的 ABC001：今天 2026-09-29 14:03:22，8 月从 12 日开户起。 */
export const septemberFigures = {
  openingBalance: '1176.6',
  recharge: '1300',
  gift: '0',
  adjustment: '-25.5',
  callCharges: '2486.3',
  closingBalance: '-35.2',
  calls: 12804,
  callMinutes: '49726',
};
export const augustFigures = {
  openingBalance: '0',
  recharge: '3000',
  gift: '50',
  adjustment: '0',
  callCharges: '1873.4',
  closingBalance: '1176.6',
  calls: 9642,
  callMinutes: '37468',
};

export const septemberCountries = [
  { country: '中国', calls: 9820, minutes: '38476', charge: '1923.8' },
  { country: '牙买加', calls: 186, minutes: '900', charge: '225' },
  { country: '英国手机', calls: 812, minutes: '2800', charge: '126' },
  { country: '日本', calls: 704, minutes: '2600', charge: '91' },
  { country: '中国香港', calls: 466, minutes: '1700', charge: '51' },
  { country: '新加坡', calls: 398, minutes: '1500', charge: '42' },
  { country: '英国', calls: 236, minutes: '1000', charge: '20' },
  { country: '美国/加拿大', calls: 182, minutes: '750', charge: '7.5' },
];
export const augustCountries = [
  { country: '中国', calls: 7350, minutes: '28803', charge: '1440.15' },
  { country: '牙买加', calls: 145, minutes: '700', charge: '175' },
  { country: '英国手机', calls: 580, minutes: '2000', charge: '90' },
  { country: '日本', calls: 540, minutes: '2000', charge: '70' },
  { country: '中国香港', calls: 384, minutes: '1400', charge: '42' },
  { country: '新加坡', calls: 318, minutes: '1200', charge: '33.6' },
  { country: '英国', calls: 212, minutes: '900', charge: '18' },
  { country: '美国/加拿大', calls: 113, minutes: '465', charge: '4.65' },
];

const tenant = { code: 'ABC001', name: '深圳市某某科技有限公司' };

/** 2026年9月（进行中）：1 日至 29 日，只有 3 天有通话，其余由页面补零；三天之和等于头部。 */
export const septemberDetail: PortalStatementResponse = {
  currency: 'CNY',
  tenant,
  month: '2026-09',
  state: 'in_progress',
  period: { from: '2026-09-01', to: '2026-09-29', openedOn: null },
  asOf: '2026-09-29T06:03:22.000Z',
  generatedAt: null,
  detailsDeleted: false,
  figures: septemberFigures,
  countries: septemberCountries,
  days: [
    { day: '2026-09-01', calls: 410, minutes: '1650', charge: '82.5' },
    { day: '2026-09-28', calls: 454, minutes: '1776', charge: '88.64' },
    { day: '2026-09-29', calls: 11940, minutes: '46300', charge: '2315.16' },
  ],
};

/** 2026年8月（已结束）：2026-08-12 开户，20 天。 */
export const augustDetail: PortalStatementResponse = {
  currency: 'CNY',
  tenant,
  month: '2026-08',
  state: 'final',
  period: { from: '2026-08-12', to: '2026-08-31', openedOn: '2026-08-12' },
  asOf: null,
  generatedAt: '2026-08-31T18:00:15.000Z',
  detailsDeleted: false,
  figures: augustFigures,
  countries: augustCountries,
  days: [
    { day: '2026-08-12', calls: 120, minutes: '630', charge: '31.5' },
    { day: '2026-08-20', calls: 480, minutes: '1870', charge: '93.5' },
    { day: '2026-08-31', calls: 9042, minutes: '34968', charge: '1748.4' },
  ],
};

export const statementsResponse: PortalStatementsResponse = {
  currency: 'CNY',
  asOf: '2026-09-29T06:03:22.000Z',
  items: [
    {
      month: '2026-09',
      state: 'in_progress',
      figures: septemberFigures,
      generatedAt: null,
      detailsDeleted: false,
    },
    {
      month: '2026-08',
      state: 'final',
      figures: augustFigures,
      generatedAt: '2026-08-31T18:00:15.000Z',
      detailsDeleted: false,
    },
  ],
};

const zeroFigures = {
  openingBalance: '0',
  recharge: '0',
  gift: '0',
  adjustment: '0',
  callCharges: '0',
  closingBalance: '0',
  calls: 0,
  callMinutes: '0',
};

/** 新开户租户：只有全零的进行中月份，没有账单行。 */
export const emptyStatementsResponse: PortalStatementsResponse = {
  currency: 'USD',
  asOf: '2026-09-29T06:03:22.000Z',
  items: [
    {
      month: '2026-09',
      state: 'in_progress',
      figures: zeroFigures,
      generatedAt: null,
      detailsDeleted: false,
    },
  ],
};
