import Decimal from 'decimal.js';
import {
  formatCountryLabel,
  formatHangupCause,
  type Currency,
  type PortalCdr,
} from '@fs-billing/shared';
import { formatDateTime } from '../../lib/format';

const countFormat = new Intl.NumberFormat('en-US');

export const cdrRateUnit = {
  CNY: '元/分钟',
  USD: '$/分钟',
} as const satisfies Record<Currency, string>;

/** 列表第一列的时刻：已接通按接通时间，未接通按振铃开始（与日期归属一致）。 */
export function cdrMoment(cdr: PortalCdr) {
  return cdr.answeredAt ?? cdr.startedAt;
}

/** 「国家 · 说明」，说明为空只显示国家。未接通话单没有国家，与 CSV 一致写「未接通」。 */
export function cdrCountryLabel(cdr: PortalCdr) {
  return cdr.country === null
    ? '未接通'
    : formatCountryLabel(cdr.country, cdr.description);
}

/** 计费分钟是整数；四舍五入到整数后加千分位，如 49,726分钟。 */
export function formatMinutes(value: string) {
  const minutes = new Decimal(value)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  return `${countFormat.format(minutes)}分钟`;
}

export function formatCount(value: number) {
  return countFormat.format(value);
}

/** 手机卡片的短时间，如 09-29 00:30:00。 */
export function cdrShortMoment(cdr: PortalCdr) {
  return formatDateTime(cdrMoment(cdr)).slice(5);
}

export function cdrHangupCause(cdr: PortalCdr) {
  return cdr.hangupCause === '' ? '—' : formatHangupCause(cdr.hangupCause);
}
