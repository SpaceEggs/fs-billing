import Decimal from 'decimal.js';
import type { Currency, Money as MoneyValue } from '@fs-billing/shared';
import {
  formatDateTime,
  formatExactMoney,
  formatMoney,
  formatRate,
} from '../lib/format';
import { cn } from '../lib/utils';

/** 金额：等宽数字，负数为红色；`signed` 时正数显示为入账绿色并带「+」。 */
export function Money({
  value,
  tone = 'negative',
  exact = false,
  className,
}: {
  value: MoneyValue;
  tone?: 'negative' | 'signed' | 'plain';
  /** 不舍入到 2 位，如四位小数调账。 */
  exact?: boolean;
  className?: string;
}) {
  // 与 formatMoney 相同的舍入，正负号按显示出来的值判断：-0.0001 显示为 ¥0.00，不带符号。
  const shown = exact
    ? new Decimal(value.amount)
    : new Decimal(value.amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const negative = shown.isNegative() && !shown.isZero();
  const text = exact ? formatExactMoney(value) : formatMoney(value);
  return (
    <span
      className={cn(
        'tabular-nums',
        tone !== 'plain' && negative && 'text-neg',
        tone === 'signed' && !negative && 'text-pos',
        className,
      )}
    >
      {tone === 'signed' && shown.gt(0) ? `+${text}` : text}
    </span>
  );
}

export function Rate({
  value,
  currency,
  unit = false,
  className,
}: {
  value: string;
  currency?: Currency;
  unit?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('tabular-nums', className)}>
      {formatRate(value, currency ? { currency, unit } : { unit })}
    </span>
  );
}

/** 北京时间 YYYY-MM-DD HH:mm:ss。 */
export function DateTime({
  value,
  className,
}: {
  value: string;
  className?: string;
}) {
  return (
    <time dateTime={value} className={cn('tabular-nums', className)}>
      {formatDateTime(value)}
    </time>
  );
}
