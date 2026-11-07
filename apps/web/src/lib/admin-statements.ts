import { beijingDateOf, translate, type Locale } from '@fs-billing/shared';
import { currentLocale } from '../i18n';

/** 当前北京月的上一个月（后台账单页的默认月份，也是能选的最晚月份）。 */
export function previousBeijingMonth(now: Date) {
  return shiftStatementMonth(beijingDateOf(now).slice(0, 7), -1);
}

export function shiftStatementMonth(month: string, delta: number) {
  const index =
    Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + delta;
  const year = Math.floor(index / 12);
  return `${String(year).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

export type ReconcileStatus = 'unchecked' | 'ok' | 'stale' | 'inconsistent';

/**
 * 核对不一致时写在生成时间下面的备注（决定 27）：stale 即「账单已过期」，
 * inconsistent 即「账单与流水不一致」；一致、未核对与没有账单行都没有备注。
 */
export function reconcileNote(
  status: ReconcileStatus | null,
  locale: Locale = currentLocale(),
) {
  if (status === 'stale')
    return translate(locale, 'admin:statement.reconcile.stale');
  if (status === 'inconsistent')
    return translate(locale, 'admin:statement.reconcile.inconsistent');
  return null;
}

export type RegenerateReason = 'in_progress' | 'details_deleted';

/** 重新生成不可用的原因；可用时为 null。 */
export const regenerateReasons = {
  in_progress: translate('zh', 'admin:statement.regenerate.inProgress'),
  details_deleted: translate('zh', 'admin:statement.regenerate.detailsDeleted'),
} as const satisfies Record<RegenerateReason, string>;

export function regenerateReason(
  reason: RegenerateReason,
  locale: Locale = currentLocale(),
) {
  return translate(
    locale,
    reason === 'in_progress'
      ? 'admin:statement.regenerate.inProgress'
      : 'admin:statement.regenerate.detailsDeleted',
  );
}
