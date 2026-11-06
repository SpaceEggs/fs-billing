import Decimal from 'decimal.js';
import type { z } from 'zod';
import {
  translate,
  type AdminBalanceOperationRequest,
  type AdminLedgerKind,
  type AdminTenantDetailResponse,
  type TenantHealth,
  type Currency,
  type Locale,
  type ValidationIssue,
  type adminBalanceOperationRequestSchema,
} from '@fs-billing/shared';
import { webConfig } from '../config';
import { issueText } from './api-problem';
import { beginAttempt } from './balance-attempts';
import {
  amountDecimals,
  amountFormatMessage,
  amountSchemas,
  normalizeAmountInput,
} from './amounts';
import { currentLocale } from '../i18n';

export type BalanceKind = AdminBalanceOperationRequest['kind'];
type NoteField = 'note' | 'internalNote' | 'reason';

const balanceKindKey = {
  topup: 'topup',
  credit_topup: 'creditTopup',
  gift: 'gift',
  adjustment: 'adjustment',
} as const satisfies Record<BalanceKind, string>;

const ledgerKindKey = {
  recharge: 'recharge',
  credit_recharge: 'creditRecharge',
  gift: 'gift',
  adjustment: 'adjustment',
  call_charge: 'callCharge',
} as const satisfies Record<AdminLedgerKind, string>;

/** 余额操作类型的名称；英文界面用。 */
export function balanceKindLabel(
  kind: BalanceKind,
  locale: Locale = currentLocale(),
) {
  return translate(locale, `admin:balance.kind.${balanceKindKey[kind]}`);
}

export function balanceKindConfirmType(
  kind: BalanceKind,
  locale: Locale = currentLocale(),
) {
  return translate(locale, `admin:balance.confirmType.${balanceKindKey[kind]}`);
}

export function balanceKindHint(
  kind: BalanceKind,
  locale: Locale = currentLocale(),
) {
  return translate(locale, `admin:balance.hint.${balanceKindKey[kind]}`);
}

/** 流水类型名称；`ledgerKindLabels` 是中文兼容值。 */
export function ledgerKindLabel(
  kind: AdminLedgerKind,
  locale: Locale = currentLocale(),
) {
  return translate(locale, `admin:balance.ledgerKind.${ledgerKindKey[kind]}`);
}

/** 四种人工余额操作的规则：精度、正负、备注字段与可见性、是否适用大额确认。 */
export const balanceKinds = {
  topup: {
    label: balanceKindLabel('topup', 'zh'),
    confirmType: balanceKindConfirmType('topup', 'zh'),
    signed: false,
    decimals: amountDecimals.topup,
    hint: balanceKindHint('topup', 'zh'),
    noteField: 'note',
    noteVisibility: 'customer',
    largeAmountConfirm: false,
  },
  credit_topup: {
    label: balanceKindLabel('credit_topup', 'zh'),
    confirmType: balanceKindConfirmType('credit_topup', 'zh'),
    signed: false,
    decimals: amountDecimals.topup,
    hint: balanceKindHint('credit_topup', 'zh'),
    noteField: 'internalNote',
    noteVisibility: 'admin',
    largeAmountConfirm: true,
  },
  gift: {
    label: balanceKindLabel('gift', 'zh'),
    confirmType: balanceKindConfirmType('gift', 'zh'),
    signed: false,
    decimals: amountDecimals.topup,
    hint: balanceKindHint('gift', 'zh'),
    noteField: 'note',
    noteVisibility: 'customer',
    largeAmountConfirm: true,
  },
  adjustment: {
    label: balanceKindLabel('adjustment', 'zh'),
    confirmType: balanceKindConfirmType('adjustment', 'zh'),
    signed: true,
    decimals: amountDecimals.adjustment,
    hint: balanceKindHint('adjustment', 'zh'),
    noteField: 'reason',
    noteVisibility: 'customer',
    largeAmountConfirm: false,
  },
} as const satisfies Record<
  BalanceKind,
  {
    label: string;
    confirmType: string;
    signed: boolean;
    decimals: number;
    hint: string;
    noteField: NoteField;
    noteVisibility: 'customer' | 'admin';
    largeAmountConfirm: boolean;
  }
>;
export const balanceKindOrder = [
  'topup',
  'credit_topup',
  'gift',
  'adjustment',
] as const satisfies readonly BalanceKind[];

export const ledgerKindLabels = {
  recharge: ledgerKindLabel('recharge', 'zh'),
  credit_recharge: ledgerKindLabel('credit_recharge', 'zh'),
  gift: ledgerKindLabel('gift', 'zh'),
  adjustment: ledgerKindLabel('adjustment', 'zh'),
  call_charge: ledgerKindLabel('call_charge', 'zh'),
} as const satisfies Record<AdminLedgerKind, string>;

export type BalanceDraft = { kind: BalanceKind; amount: string; note: string };
export type BalanceErrors = { amount?: string; note?: string; form?: string };

const noteMaxLength = 2000;

/** 本地校验；与契约同一套金额 schema，错误信息按字段给出。 */
export function validateBalanceDraft(
  draft: BalanceDraft,
  locale: Locale = currentLocale(),
): BalanceErrors {
  const rule = balanceKinds[draft.kind];
  const errors: BalanceErrors = {};
  const amount = normalizeAmountInput(draft.amount);
  const schema = rule.signed
    ? amountSchemas.adjustment
    : amountSchemas.positive;
  if (!amount)
    errors.amount = translate(locale, 'admin:balance.amountRequired');
  else if (!schema.safeParse(amount).success) {
    const numeric = /^-?\d+(?:\.\d+)?$/.test(amount);
    if (numeric && new Decimal(amount).isZero())
      errors.amount = rule.signed
        ? translate(locale, 'admin:balance.adjustmentZero')
        : translate(locale, 'admin:balance.amountPositive');
    else if (numeric && !rule.signed && amount.startsWith('-'))
      errors.amount = translate(locale, 'admin:balance.amountPositive');
    else
      errors.amount = translate(locale, 'admin:balance.amountFormat', {
        message: amountFormatMessage(rule.decimals, locale),
      });
  }
  if (draft.kind === 'adjustment' && !draft.note.trim())
    errors.note = translate(locale, 'admin:balance.adjustmentNoteRequired');
  else if (draft.note.length > noteMaxLength)
    errors.note = translate(locale, 'admin:balance.noteTooLong', {
      max: noteMaxLength,
    });
  return errors;
}

export type BalanceRequestBody = z.input<
  typeof adminBalanceOperationRequestSchema
>;

/** 已通过校验的草稿组装为请求体；`idempotencyKey` 由调用方在重试时复用。 */
export function balanceRequest(
  draft: BalanceDraft,
  currency: Currency,
  idempotencyKey: string,
): BalanceRequestBody {
  const amount = normalizeAmountInput(draft.amount);
  const base = { currency, idempotencyKey, amount };
  switch (draft.kind) {
    case 'topup':
    case 'gift':
      return { ...base, kind: draft.kind, note: draft.note.trim() };
    case 'credit_topup':
      return { ...base, kind: draft.kind, internalNote: draft.note.trim() };
    case 'adjustment':
      return { ...base, kind: draft.kind, reason: draft.note.trim() };
  }
}

/**
 * 同一租户的同一笔草稿（类型、金额、备注都不变）得到同一指纹；内容一变即不同。
 * 金额按数值规范化（500、500.0、500.00 同一指纹），不舍入。草稿须已通过校验。
 * 指纹是 SHA-256 摘要，内存里不留金额和备注原文。
 */
export async function draftFingerprint(tenantId: string, draft: BalanceDraft) {
  const canonical = JSON.stringify([
    tenantId,
    draft.kind,
    new Decimal(normalizeAmountInput(draft.amount)).toFixed(),
    draft.note.trim(),
  ]);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** 草稿按指纹登记为一次提交，见 balance-attempts。 */
export function beginBalanceAttempt(
  owner: string,
  tenantId: string,
  draft: BalanceDraft,
) {
  return beginAttempt(owner, () => draftFingerprint(tenantId, draft));
}

/**
 * 赠送、赊账充值金额严格超过该币种阈值时需要大额二次确认；恰等于阈值不需要。
 * 阈值为前端配置（decision e），API 没有确认凭据。
 */
export function needsLargeAmountConfirm(
  kind: BalanceKind,
  amount: string,
  currency: Currency,
  thresholds: Record<Currency, string> = webConfig.largeAmountThresholds,
) {
  if (!balanceKinds[kind].largeAmountConfirm) return false;
  return new Decimal(normalizeAmountInput(amount)).gt(thresholds[currency]);
}

/** 与服务端 health 计算一致（packages/db admin/tenants.ts）。 */
export function healthAfter(
  tenant: Pick<
    AdminTenantDetailResponse,
    'status' | 'overdraftLimit' | 'settings'
  >,
  balance: Decimal,
): TenantHealth {
  if (tenant.status === 'disabled') return 'disabled';
  if (balance.plus(tenant.overdraftLimit).lte(0)) return 'suspended';
  if (balance.lt(0)) return 'overdraft';
  if (balance.lt(tenant.settings.lowBalanceThreshold)) return 'low_balance';
  return 'normal';
}

/** 操作后的余额、可用额度与状态，仅用于确认前预览；以服务端返回为准。 */
export function projectBalance(
  tenant: Pick<
    AdminTenantDetailResponse,
    'status' | 'balance' | 'overdraftLimit' | 'settings'
  >,
  amount: string,
) {
  const balance = new Decimal(tenant.balance).plus(
    normalizeAmountInput(amount),
  );
  return {
    balance: balance.toFixed(),
    available: balance.plus(tenant.overdraftLimit).toFixed(),
    health: healthAfter(tenant, balance),
  };
}

/** 服务端 VALIDATION_ERROR 的字段路径映射到对话框字段。 */
export function balanceFieldErrors(
  issues: ValidationIssue[],
  locale: Locale = currentLocale(),
): BalanceErrors {
  const errors: BalanceErrors = {};
  for (const issue of issues) {
    const [head] = issue.path;
    const field =
      head === 'amount'
        ? 'amount'
        : head === 'note' || head === 'internalNote' || head === 'reason'
          ? 'note'
          : 'form';
    errors[field] ??= issueText(issue, (key, params) =>
      translate(locale, key, params),
    );
  }
  return errors;
}
