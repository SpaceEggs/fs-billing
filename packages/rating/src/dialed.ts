declare const dialedBrand: unique symbol;

/**
 * 已规范化的被叫号码：只含数字，且不以 00 开头。FreeSWITCH dialplan 在调用授权接口
 * 和推送话单前去掉开头的 `+` / `00`，计费系统不做猜测性规范化。
 */
export type DialedNumber = string & { readonly [dialedBrand]: true };

const DIGITS = /^\d+$/;
// 00 是未去掉的国际冠字；E.164 国家码不以 0 开头。
const INTERNATIONAL_PREFIX = /^00/;

export function parseDialedNumber(raw: string): DialedNumber | undefined {
  return DIGITS.test(raw) && !INTERNATIONAL_PREFIX.test(raw)
    ? (raw as DialedNumber)
    : undefined;
}
