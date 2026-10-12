import { Decimal } from 'decimal.js';

// 金额从十进制字符串进入；具体计费规则与带币种品牌类型在阶段 1 实现。
export function decimal(value: string): Decimal {
  const result = new Decimal(value);
  if (!result.isFinite()) throw new Error('金额必须是有限十进制数');
  return result;
}
