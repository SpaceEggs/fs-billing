import Decimal from 'decimal.js';
import {
  createAdminInputAmountSchemas,
  DEFAULT_ADMIN_ADJUSTMENT_DECIMAL_PLACES,
  DEFAULT_ADMIN_SETTINGS_DECIMAL_PLACES,
  DEFAULT_ADMIN_TOPUP_DECIMAL_PLACES,
  DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS,
} from '@fs-billing/shared';

/**
 * 人工金额的整数位上限。服务端可配置，前端按默认值校验（2026-10-15 决定，不改契约）；
 * 服务端配置更小时，以返回的 VALIDATION_ERROR 为准。
 */
export const amountMaxIntegerDigits = DEFAULT_ADMIN_AMOUNT_MAX_INTEGER_DIGITS;
export const amountSchemas = createAdminInputAmountSchemas(
  amountMaxIntegerDigits,
);
export const amountDecimals = {
  topup: DEFAULT_ADMIN_TOPUP_DECIMAL_PLACES,
  adjustment: DEFAULT_ADMIN_ADJUSTMENT_DECIMAL_PLACES,
  settings: DEFAULT_ADMIN_SETTINGS_DECIMAL_PLACES,
} as const;

export const amountFormatMessage = (decimals: number) =>
  `须为数字，最多 ${amountMaxIntegerDigits} 位整数、${decimals} 位小数`;

/**
 * 输入框里的金额转为契约格式：去掉千分位逗号、空格和正号，并去掉前导零（“0500”→“500”）。
 * 不是数字时原样返回，交给契约校验报错。
 */
export function normalizeAmountInput(raw: string) {
  const compact = raw.replace(/[\s,，]/g, '').replace(/^\+/, '');
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(compact)) return compact;
  const [integer = '', fraction] = compact.replace(/^-/, '').split('.');
  const sign = compact.startsWith('-') ? '-' : '';
  const trimmed = integer.replace(/^0+(?=\d)/, '') || '0';
  return `${sign}${trimmed}${fraction ? `.${fraction}` : ''}`;
}

/** 透支额度、提醒阈值：非负、2 位小数、整数位不超过上限。 */
export function settingsAmountError(
  value: string,
  label: string,
): string | undefined {
  if (!value.trim()) return `请输入${label}`;
  const amount = normalizeAmountInput(value);
  if (amount.startsWith('-'))
    return label === '透支额度'
      ? '透支额度不能为负数，不允许透支请填 0'
      : `${label}不能为负数`;
  return amountSchemas.settings.safeParse(amount).success
    ? undefined
    : `${label}${amountFormatMessage(amountDecimals.settings)}`;
}

/** 已保存的金额可能有历史精度（多于两位），回填表单时不截断。 */
export function amountForInput(amount: string) {
  const value = new Decimal(amount);
  return value.decimalPlaces() <= 2 ? value.toFixed(2) : value.toFixed();
}
