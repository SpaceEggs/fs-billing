declare const dialedBrand: unique symbol;

/**
 * 用于费率匹配和入账的国际号码，国家码开头，最多 15 位 ASCII 数字。
 */
export type DialedNumber = string & { readonly [dialedBrand]: true };

export function parseDialedNumber(raw: string): DialedNumber | undefined {
  return /^[1-9][0-9]{0,14}(?![\s\S])/.test(raw)
    ? (raw as DialedNumber)
    : undefined;
}

/** 原拨号只用于路由。最长 17 位数字允许 00 冠字加 15 位 E.164。 */
export function normalizeDialedNumber(raw: string): DialedNumber | undefined {
  if (!/^\+?[0-9]{1,17}(?![\s\S])/.test(raw)) return undefined;
  const billing = raw.startsWith('+')
    ? raw.slice(1)
    : raw.startsWith('00')
      ? raw.slice(2)
      : `86${raw.startsWith('0') ? raw.slice(1) : raw}`;
  return parseDialedNumber(billing);
}

export interface BillingNumberInput {
  readonly callee: string;
  readonly dialedNumber?: string | undefined;
  readonly billingNumber?: string | undefined;
}

/** 无 dialedNumber 是旧版协议，callee 已是国际号码，不能再次加 86。 */
export function resolveBillingNumber(
  input: BillingNumberInput,
): DialedNumber | undefined {
  if (input.dialedNumber === undefined && input.billingNumber !== undefined)
    return undefined;
  if (input.dialedNumber !== undefined && input.callee !== input.dialedNumber)
    return undefined;
  const billing =
    input.dialedNumber === undefined
      ? parseDialedNumber(input.callee)
      : normalizeDialedNumber(input.dialedNumber);
  return billing &&
    (input.billingNumber === undefined || input.billingNumber === billing)
    ? billing
    : undefined;
}
