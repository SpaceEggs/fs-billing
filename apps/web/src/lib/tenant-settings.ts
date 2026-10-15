import Decimal from 'decimal.js';
import type { z } from 'zod';
import type {
  AdminTenantDetailResponse,
  ValidationIssue,
  adminTenantSettingsRequestSchema,
} from '@fs-billing/shared';
import {
  amountForInput,
  normalizeAmountInput,
  settingsAmountError,
} from './amounts';
import { invalidRecipient, maxRecipients } from './tenant-create';

export type SettingsForm = {
  overdraftLimit: string;
  lowBalanceThreshold: string;
  emails: string[];
};
export type SettingsField = keyof SettingsForm | 'form';
export type SettingsErrors = Partial<Record<SettingsField, string>>;
export type SettingsRequest = z.input<typeof adminTenantSettingsRequestSchema>;

export function settingsForm(tenant: AdminTenantDetailResponse): SettingsForm {
  return {
    overdraftLimit: amountForInput(tenant.overdraftLimit),
    lowBalanceThreshold: amountForInput(tenant.settings.lowBalanceThreshold),
    emails: tenant.settings.emails,
  };
}

export function validateSettings(
  form: SettingsForm,
):
  { ok: true; value: SettingsRequest } | { ok: false; errors: SettingsErrors } {
  const errors: SettingsErrors = {};
  const overdraft = settingsAmountError(form.overdraftLimit, '透支额度');
  if (overdraft) errors.overdraftLimit = overdraft;
  const threshold = settingsAmountError(
    form.lowBalanceThreshold,
    '余额提醒阈值',
  );
  if (threshold) errors.lowBalanceThreshold = threshold;
  const badEmail = invalidRecipient(form.emails);
  if (badEmail) errors.emails = `「${badEmail}」不是有效的邮箱地址`;
  else if (form.emails.length > maxRecipients)
    errors.emails = `最多 ${maxRecipients} 个通知邮箱`;
  if (Object.keys(errors).length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      overdraftLimit: normalizeAmountInput(form.overdraftLimit),
      lowBalanceThreshold: normalizeAmountInput(form.lowBalanceThreshold),
      emails: form.emails,
    },
  };
}

export type SettingsChanges = {
  overdraftLimit: { before: string; after: string } | null;
  /** 透支额度变化时的可用额度变化（余额 + 透支额度）。 */
  availableBalance: { before: string; after: string } | null;
  lowBalanceThreshold: { before: string; after: string } | null;
  emailsAdded: string[];
  emailsRemoved: string[];
};

/** 保存前的变更摘要（设计稿 2c）；金额按数值比较，“100” 与 “100.00” 视为未变。 */
export function settingsChanges(
  tenant: AdminTenantDetailResponse,
  request: SettingsRequest,
): SettingsChanges {
  const overdraftChanged = !new Decimal(tenant.overdraftLimit).eq(
    request.overdraftLimit,
  );
  const thresholdChanged = !new Decimal(tenant.settings.lowBalanceThreshold).eq(
    request.lowBalanceThreshold,
  );
  const before = new Set(tenant.settings.emails);
  const after = new Set(request.emails);
  return {
    overdraftLimit: overdraftChanged
      ? { before: tenant.overdraftLimit, after: request.overdraftLimit }
      : null,
    availableBalance: overdraftChanged
      ? {
          before: tenant.availableBalance,
          after: new Decimal(tenant.balance)
            .plus(request.overdraftLimit)
            .toFixed(),
        }
      : null,
    lowBalanceThreshold: thresholdChanged
      ? {
          before: tenant.settings.lowBalanceThreshold,
          after: request.lowBalanceThreshold,
        }
      : null,
    emailsAdded: request.emails.filter((email) => !before.has(email)),
    emailsRemoved: tenant.settings.emails.filter((email) => !after.has(email)),
  };
}

export function hasSettingsChanges(changes: SettingsChanges) {
  return Boolean(
    changes.overdraftLimit ||
    changes.lowBalanceThreshold ||
    changes.emailsAdded.length ||
    changes.emailsRemoved.length,
  );
}

export function serverSettingsErrors(issues: ValidationIssue[]) {
  const errors: SettingsErrors = {};
  for (const issue of issues) {
    const [head] = issue.path;
    const field: SettingsField =
      head === 'overdraftLimit' ||
      head === 'lowBalanceThreshold' ||
      head === 'emails'
        ? head
        : 'form';
    errors[field] ??= issue.message;
  }
  return errors;
}
