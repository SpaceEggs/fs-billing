declare const dialedBrand: unique symbol;

/**
 * 用于费率匹配和入账的国际号码，国家码开头，6 至 15 位 ASCII 数字。
 */
export type DialedNumber = string & { readonly [dialedBrand]: true };

export function parseDialedNumber(raw: string): DialedNumber | undefined {
  return /^[1-9][0-9]{5,14}(?![\s\S])/.test(raw)
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

export type BillingNumberInput = {
  readonly billingNumber?: string | undefined;
} & (
  | { readonly callee: string; readonly dialedNumber?: undefined }
  | { readonly dialedNumber: string; readonly callee?: string | undefined }
);

export type BillingNumberResult =
  | { readonly ok: true; readonly billingNumber: DialedNumber }
  | { readonly error: 'format' }
  | { readonly error: 'mismatch'; readonly billingNumber: DialedNumber };

/** 旧协议直接使用 callee；新协议以原拨号计算，并核对国际号码投影。 */
export function resolveBillingNumber(
  input: BillingNumberInput,
): BillingNumberResult {
  const billingNumber =
    input.dialedNumber === undefined
      ? parseDialedNumber(input.callee)
      : normalizeDialedNumber(input.dialedNumber);
  if (!billingNumber) return { error: 'format' };
  if (
    (input.dialedNumber === undefined && input.billingNumber !== undefined) ||
    (input.dialedNumber !== undefined &&
      input.callee !== undefined &&
      input.callee !== billingNumber) ||
    (input.billingNumber !== undefined && input.billingNumber !== billingNumber)
  ) {
    return { error: 'mismatch', billingNumber };
  }
  return { ok: true, billingNumber };
}
