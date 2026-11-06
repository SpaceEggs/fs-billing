import { en } from './i18n/en/index.js';
import { DEFAULT_LOCALE, type Locale } from './i18n/index.js';
import { zh } from './i18n/zh/index.js';

/**
 * FreeSWITCH 挂断原因（cdrs.hangup_cause 存的是 switch_cause_t 的名字）的中文对照。
 * 门户与后台的话单详情、CSV 导出共用这一张表。未收录的原因只显示英文原文。
 * 文案数据在 i18n/zh/enums.ts；这里保留导出名，兼容已有调用方。
 */
export const HANGUP_CAUSE_LABELS = zh.enums.hangupCause;

export type KnownHangupCause = keyof typeof HANGUP_CAUSE_LABELS;

function isKnown(cause: string): cause is KnownHangupCause {
  return Object.hasOwn(HANGUP_CAUSE_LABELS, cause);
}

function labelsFor(locale: Locale) {
  return locale === 'en' ? en.enums.hangupCause : zh.enums.hangupCause;
}

/** 已收录原因的当前语言名称，未收录或为空时为 undefined。 */
export function hangupCauseLabel(
  cause: string,
  locale: Locale = DEFAULT_LOCALE,
): string | undefined {
  const name = cause.trim();
  return isKnown(name) ? labelsFor(locale)[name] : undefined;
}

/**
 * 详情与导出里的显示文本，如「NORMAL_CLEARING（正常挂断）」或
 * `NORMAL_CLEARING (Normal clearing)`。未收录的原因保留英文原文，空值返回空串。
 */
export function formatHangupCause(
  cause: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  const name = cause.trim();
  const label = hangupCauseLabel(name, locale);
  if (label === undefined) return name;
  return locale === 'en' ? `${name} (${label})` : `${name}（${label}）`;
}
