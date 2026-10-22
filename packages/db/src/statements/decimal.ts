import { decimal } from '@fs-billing/rating';

/** 数据库 numeric 文本 → 规范十进制字符串：去掉多余的尾零，没有负零。 */
export function canonical(value: string): string {
  const parsed = decimal(value);
  return parsed.isZero() ? '0' : parsed.toFixed();
}

export function canonicalOrNull(value: string | null): string | null {
  return value === null ? null : canonical(value);
}
