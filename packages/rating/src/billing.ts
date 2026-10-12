import { Decimal } from 'decimal.js';
import { chargeFor, type Currency, type Money, type Rate } from './money.js';

/** 计费周期 initial/increment（秒）。60/60 为默认，6/6、1/1 只需换参数。 */
export interface BillingCycle {
  readonly initialSeconds: number;
  readonly incrementSeconds: number;
}

export const CYCLE_60_60: BillingCycle = {
  initialSeconds: 60,
  incrementSeconds: 60,
};

function assertWholeSeconds(name: string, seconds: number, min: number) {
  if (!Number.isInteger(seconds) || seconds < min) {
    throw new Error(`${name} 必须是 ≥ ${min} 的整数秒`);
  }
}

/** 接通后通话秒数 → 计费秒数。0 秒（未接通）不计费。 */
export function billedSeconds(
  talkSeconds: number,
  cycle: BillingCycle = CYCLE_60_60,
): number {
  assertWholeSeconds('通话时长', talkSeconds, 0);
  assertWholeSeconds('首段周期', cycle.initialSeconds, 1);
  assertWholeSeconds('后续周期', cycle.incrementSeconds, 1);
  if (talkSeconds === 0) return 0;
  if (talkSeconds <= cycle.initialSeconds) return cycle.initialSeconds;
  const rest = talkSeconds - cycle.initialSeconds;
  return (
    cycle.initialSeconds +
    Math.ceil(rest / cycle.incrementSeconds) * cycle.incrementSeconds
  );
}

/** 计费分钟数（Decimal，6/6 时可能是 0.1 的倍数）。 */
export function billedMinutes(
  talkSeconds: number,
  cycle: BillingCycle = CYCLE_60_60,
): Decimal {
  return new Decimal(billedSeconds(talkSeconds, cycle)).div(60);
}

export interface CallCharge<C extends Currency> {
  readonly billedMinutes: Decimal;
  readonly charge: Money<C>;
}

export function priceCall<C extends Currency>(
  talkSeconds: number,
  perMinute: Rate<C>,
  cycle: BillingCycle = CYCLE_60_60,
): CallCharge<C> {
  const minutes = billedMinutes(talkSeconds, cycle);
  return { billedMinutes: minutes, charge: chargeFor(minutes, perMinute) };
}
