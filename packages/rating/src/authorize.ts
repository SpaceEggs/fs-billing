import { Decimal } from 'decimal.js';
import { addMoney, type Currency, type Money } from './money.js';
import { findRate, type RateEntry, type RateTable } from './rates.js';

/** 单通最长 4 小时。 */
export const MAX_CALL_SECONDS = 4 * 60 * 60;

export interface Tenant<C extends Currency> {
  readonly code: string;
  readonly status: 'active' | 'disabled';
  readonly currency: C;
  readonly balance: Money<C>;
  readonly overdraft: Money<C>;
  readonly rates: RateTable<C>;
}

export type RejectReason = '租户不存在' | '租户已停用' | '无费率' | '余额不足';

export type Authorization<C extends Currency> =
  | {
      readonly allowed: true;
      readonly entry: RateEntry<C>;
      readonly callableMinutes: number;
      readonly maxSeconds: number;
    }
  | { readonly allowed: false; readonly reason: RejectReason };

/** 可打分钟数 = floor((余额 + 透支) ÷ 费率)。 */
export function callableMinutes<C extends Currency>(
  available: Money<C>,
  entry: RateEntry<C>,
): Decimal {
  if (available.value.lte(0)) return new Decimal(0);
  // 费率为 0 时不受余额限制，由单通上限封顶。
  if (entry.perMinute.perMinute.isZero()) return new Decimal(Infinity);
  return available.value.div(entry.perMinute.perMinute).floor();
}

export function authorize<C extends Currency>(
  tenant: Tenant<C> | undefined,
  dialed: string,
  at: Date,
): Authorization<C> {
  if (!tenant) return { allowed: false, reason: '租户不存在' };
  if (tenant.status !== 'active')
    return { allowed: false, reason: '租户已停用' };
  const entry = findRate(tenant.rates, dialed, at);
  if (!entry) return { allowed: false, reason: '无费率' };
  const minutes = callableMinutes(
    addMoney(tenant.balance, tenant.overdraft),
    entry,
  );
  if (minutes.lte(0)) return { allowed: false, reason: '余额不足' };
  return {
    allowed: true,
    entry,
    callableMinutes: minutes.toNumber(),
    maxSeconds: Decimal.min(minutes.mul(60), MAX_CALL_SECONDS).toNumber(),
  };
}
