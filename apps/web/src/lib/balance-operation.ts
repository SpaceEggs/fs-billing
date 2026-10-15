import Decimal from 'decimal.js';
import type { z } from 'zod';
import type {
  AdminBalanceOperationRequest,
  AdminLedgerKind,
  AdminTenantDetailResponse,
  AdminTenantHealth,
  Currency,
  ValidationIssue,
  adminBalanceOperationRequestSchema,
} from '@fs-billing/shared';
import { webConfig } from '../config';
import {
  amountDecimals,
  amountFormatMessage,
  amountSchemas,
  normalizeAmountInput,
} from './amounts';

export type BalanceKind = AdminBalanceOperationRequest['kind'];
type NoteField = 'note' | 'internalNote' | 'reason';

/** 四种人工余额操作的规则：精度、正负、备注字段与可见性、是否适用大额确认。 */
export const balanceKinds = {
  topup: {
    label: '充值',
    confirmType: '充值 · 已收款',
    signed: false,
    decimals: amountDecimals.topup,
    hint: '只能为正数',
    noteField: 'note',
    noteVisibility: 'customer',
    largeAmountConfirm: false,
  },
  credit_topup: {
    label: '赊账充值',
    confirmType: '赊账充值 · 待收款',
    signed: false,
    decimals: amountDecimals.topup,
    hint: '只能为正数，记为「待收款」',
    noteField: 'internalNote',
    noteVisibility: 'admin',
    largeAmountConfirm: true,
  },
  gift: {
    label: '赠送',
    confirmType: '赠送',
    signed: false,
    decimals: amountDecimals.topup,
    hint: '只能为正数',
    noteField: 'note',
    noteVisibility: 'customer',
    largeAmountConfirm: true,
  },
  adjustment: {
    label: '调账',
    confirmType: '调账',
    signed: true,
    decimals: amountDecimals.adjustment,
    hint: '可为负数（扣减余额），最多 4 位小数',
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
  recharge: '充值',
  credit_recharge: '赊账充值',
  gift: '赠送',
  adjustment: '调账',
  call_charge: '通话扣费',
} as const satisfies Record<AdminLedgerKind, string>;

export type BalanceDraft = { kind: BalanceKind; amount: string; note: string };
export type BalanceErrors = { amount?: string; note?: string; form?: string };

const noteMaxLength = 2000;

/** 本地校验；与契约同一套金额 schema，错误信息按字段给出。 */
export function validateBalanceDraft(draft: BalanceDraft): BalanceErrors {
  const rule = balanceKinds[draft.kind];
  const errors: BalanceErrors = {};
  const amount = normalizeAmountInput(draft.amount);
  const schema = rule.signed
    ? amountSchemas.adjustment
    : amountSchemas.positive;
  if (!amount) errors.amount = '请输入金额';
  else if (!schema.safeParse(amount).success) {
    const numeric = /^-?\d+(?:\.\d+)?$/.test(amount);
    if (numeric && new Decimal(amount).isZero())
      errors.amount = rule.signed ? '调账金额不能为 0' : '金额必须大于 0';
    else if (numeric && !rule.signed && amount.startsWith('-'))
      errors.amount = '金额必须大于 0';
    else errors.amount = `金额${amountFormatMessage(rule.decimals)}`;
  }
  if (draft.kind === 'adjustment' && !draft.note.trim())
    errors.note = '调账必须填写备注';
  else if (draft.note.length > noteMaxLength)
    errors.note = `备注最多 ${noteMaxLength} 个字符`;
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

/** 同一笔草稿（类型、金额、备注都不变）重试时复用幂等键；内容一变即换新键。 */
export function draftFingerprint(draft: BalanceDraft) {
  return JSON.stringify([
    draft.kind,
    normalizeAmountInput(draft.amount),
    draft.note.trim(),
  ]);
}

export function newIdempotencyKey() {
  return `web:${crypto.randomUUID()}`;
}

const unresolvedAttempts = new Map<
  string,
  { fingerprint: string; key: string }
>();

/**
 * 每个租户保留最近一笔结果未知的提交：关闭对话框后重新填写同一内容，仍按同一幂等键重试。
 * 只有确定成功或服务端明确拒绝时才由 `resolveBalanceAttempt` 清除。
 */
export function balanceAttemptKey(tenantId: string, draft: BalanceDraft) {
  const fingerprint = draftFingerprint(draft);
  const unresolved = unresolvedAttempts.get(tenantId);
  const key =
    unresolved?.fingerprint === fingerprint
      ? unresolved.key
      : newIdempotencyKey();
  unresolvedAttempts.set(tenantId, { fingerprint, key });
  return key;
}

export function resolveBalanceAttempt(tenantId: string, key: string) {
  if (unresolvedAttempts.get(tenantId)?.key === key)
    unresolvedAttempts.delete(tenantId);
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
): AdminTenantHealth {
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
export function balanceFieldErrors(issues: ValidationIssue[]): BalanceErrors {
  const errors: BalanceErrors = {};
  for (const issue of issues) {
    const [head] = issue.path;
    const field =
      head === 'amount'
        ? 'amount'
        : head === 'note' || head === 'internalNote' || head === 'reason'
          ? 'note'
          : 'form';
    errors[field] ??= issue.message;
  }
  return errors;
}
