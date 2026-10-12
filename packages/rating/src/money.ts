import { Decimal } from 'decimal.js';

export type Currency = 'CNY' | 'USD';

declare const moneyBrand: unique symbol;
declare const rateBrand: unique symbol;

/** 某币种的金额。品牌字段只存在于类型层，外部无法用对象字面量伪造。 */
export interface Money<C extends Currency = Currency> {
  readonly [moneyBrand]: true;
  readonly currency: C;
  readonly value: Decimal;
}

/** 某币种的每分钟费率。与 Money 不可互换，最多 4 位小数。 */
export interface Rate<C extends Currency = Currency> {
  readonly [rateBrand]: true;
  readonly currency: C;
  readonly perMinute: Decimal;
}

export function decimal(value: string): Decimal {
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error('金额必须是有限十进制数');
  return result;
}

function fromDecimal<C extends Currency>(
  currency: C,
  value: Decimal,
): Money<C> {
  return { currency, value } as Money<C>;
}

export function money<C extends Currency>(
  currency: C,
  value: string,
): Money<C> {
  return fromDecimal(currency, decimal(value));
}

export function rate<C extends Currency>(currency: C, value: string): Rate<C> {
  const perMinute = decimal(value);
  if (perMinute.isNegative()) throw new Error('费率不能为负');
  if (perMinute.decimalPlaces() > 4) throw new Error('费率最多 4 位小数');
  return { currency, perMinute } as Rate<C>;
}

function sameCurrency(a: { currency: Currency }, b: { currency: Currency }) {
  if (a.currency !== b.currency) {
    throw new Error(`币种不一致：${a.currency} 与 ${b.currency}`);
  }
}

/** 同币种相加。第二个参数用 NoInfer，CNY + USD 在类型检查阶段报错。 */
export function addMoney<C extends Currency>(
  a: Money<C>,
  b: Money<NoInfer<C>>,
): Money<C> {
  sameCurrency(a, b);
  return fromDecimal(a.currency, a.value.plus(b.value));
}

/** 费用 = 计费分钟数 × 费率，不做任何舍入。 */
export function chargeFor<C extends Currency>(
  billedMinutes: Decimal,
  perMinute: Rate<C>,
): Money<C> {
  return fromDecimal(
    perMinute.currency,
    billedMinutes.mul(perMinute.perMinute),
  );
}

/** 仅用于显示：保留 2 位小数，四舍五入。 */
export function formatMoney(amount: Money): string {
  return amount.value.toFixed(2, Decimal.ROUND_HALF_UP);
}
