import { formatDate } from './format';

/** 当前北京月的上一个月（后台账单页的默认月份，也是能选的最晚月份）。 */
export function previousBeijingMonth(now: Date) {
  return shiftStatementMonth(formatDate(now).slice(0, 7), -1);
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
export function reconcileNote(status: ReconcileStatus | null) {
  if (status === 'stale') return '账单已过期';
  if (status === 'inconsistent') return '账单与流水不一致';
  return null;
}

/** 重新生成不可用的原因；可用时为 null。 */
export const regenerateReasons = {
  in_progress: '进行中，月结后可重新生成',
  details_deleted: '话单已删除，无法重新计算',
} as const;
