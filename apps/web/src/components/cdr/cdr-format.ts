import Decimal from 'decimal.js';
import {
  formatCountryLabel,
  formatHangupCause,
  translate,
  type Currency,
  type Locale,
  type PortalCdr,
} from '@fs-billing/shared';
import { currentLocale } from '../../i18n';
import { formatShortDateTime } from '../../lib/format';

const countFormat = new Intl.NumberFormat('en-US');

/** 列表与详情里的费率单位：中文「元/分钟」，英文「¥/min」（docs/i18n-design.md §7）。 */
export function cdrRateUnit(
  currency: Currency,
  locale: Locale = currentLocale(),
) {
  return translate(
    locale,
    currency === 'CNY' ? 'format:rateUnit.cny' : 'format:rateUnit.usd',
  );
}

/** 列表第一列的时刻：已接通按接通时间，未接通按振铃开始（与日期归属一致）。 */
export function cdrMoment(cdr: PortalCdr) {
  return cdr.answeredAt ?? cdr.startedAt;
}

/** 呼入话单没有国家；列表与详情显示「—」。 */
export function cdrIsInbound(cdr: Pick<PortalCdr, 'direction'>) {
  return cdr.direction === 'inbound';
}

export function cdrDirectionLabel(
  cdr: Pick<PortalCdr, 'direction'>,
  locale: Locale = currentLocale(),
) {
  return translate(
    locale,
    cdrIsInbound(cdr) ? 'cdr:direction.inbound' : 'cdr:direction.outbound',
  );
}

/** 「国家 · 说明」，说明为空只显示国家。未接通的呼出没有国家，与 CSV 一致写「未接通」。 */
export function cdrCountryLabel(
  cdr: PortalCdr,
  locale: Locale = currentLocale(),
) {
  if (cdrIsInbound(cdr)) return '—';
  return cdr.country === null
    ? translate(locale, 'cdr:notConnected')
    : formatCountryLabel(cdr.country, cdr.description);
}

/** 计费分钟是整数；四舍五入到整数后加千分位，如 49,726分钟。 */
export function formatMinutes(value: string, locale: Locale = currentLocale()) {
  const minutes = new Decimal(value)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toNumber();
  return translate(locale, 'format:billedMinutes', {
    minutes: countFormat.format(minutes),
  });
}

export function formatCount(value: number) {
  return countFormat.format(value);
}

/** 手机卡片的短时间：中文 09-29 00:30:00，英文 29 Sep 00:30:00。 */
export function cdrShortMoment(
  cdr: PortalCdr,
  locale: Locale = currentLocale(),
) {
  return formatShortDateTime(cdrMoment(cdr), locale);
}

export function cdrHangupCause(
  cdr: PortalCdr,
  locale: Locale = currentLocale(),
) {
  return cdr.hangupCause === ''
    ? '—'
    : formatHangupCause(cdr.hangupCause, locale);
}
