import Decimal from 'decimal.js';
import type { Currency, Money as MoneyValue } from '@fs-billing/shared';
import {
  formatDateTime,
  formatExactMoney,
  formatMoney,
  formatRate,
  isNegativeMoney,
} from '../lib/format';
import { cn } from '../lib/utils';

/** 金额：等宽数字，负数为红色；`signed` 时正数显示为入账绿色。 */
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
  const exactAmount = new Decimal(value.amount);
  const negative = exact
    ? exactAmount.isNegative() && !exactAmount.isZero()
    : isNegativeMoney(value);
  return (
    <span
      className={cn(
        'tabular-nums',
        tone !== 'plain' && negative && 'text-neg',
        tone === 'signed' && !negative && 'text-pos',
        className,
      )}
    >
      {exact ? formatExactMoney(value) : formatMoney(value)}
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
