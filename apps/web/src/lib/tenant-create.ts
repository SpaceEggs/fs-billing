import Decimal from 'decimal.js';
import { z } from 'zod';
import {
  adminPortalAccountCreateRequestSchema,
  adminTenantCreateRequestSchema,
  DEFAULT_TENANT_OVERDRAFT_LIMIT,
  newPasswordSchema,
  translate,
  type AdminPortalAccountCreateRequest,
  type Currency,
  type Locale,
  type ValidationIssue,
} from '@fs-billing/shared';
import { normalizeAmountInput, settingsAmountError } from './amounts';
import { issueText } from './api-problem';
import { currentLocale } from '../i18n';

export const maxRecipients = 20;

export type RatesChoice =
  | { kind: 'blank' }
  | { kind: 'csv'; file: { filename: string; contentBase64: string } | null }
  | {
      kind: 'copy';
      /** label 供创建成功后说明，例如“已复制 XYZ002 的 14 条费率”。 */
      source: { tenantId: string; versionId: string; label: string } | null;
    };

export type TenantForm = {
  code: string;
  name: string;
  currency: Currency;
  overdraftLimit: string;
  /** 管理员改过透支额度后，切换币种不再覆盖。 */
  overdraftEdited: boolean;
  lowBalanceThreshold: string;
  emails: string[];
  contactName: string;
  contactPhone: string;
  remark: string;
  portalEmail: string;
  portalPassword: string;
  rates: RatesChoice;
};

export type FieldKey =
  | 'code'
  | 'name'
  | 'overdraftLimit'
  | 'lowBalanceThreshold'
  | 'emails'
  | 'contactName'
  | 'contactPhone'
  | 'remark'
  | 'portalEmail'
  | 'portalPassword'
  | 'rates'
  /** 无法归属到单个字段的错误。 */
  | 'form';
export type FieldErrors = Partial<Record<FieldKey, string>>;

export function defaultOverdraft(currency: Currency) {
  return new Decimal(DEFAULT_TENANT_OVERDRAFT_LIMIT[currency]).toFixed(2);
}

/** 通知邮箱默认只填当前管理员邮箱（design.md §8.1），与服务端省略时的默认一致。 */
export function initialTenantForm(adminEmail: string): TenantForm {
  return {
    code: '',
    name: '',
    currency: 'CNY',
    overdraftLimit: defaultOverdraft('CNY'),
    overdraftEdited: false,
    lowBalanceThreshold: '',
    emails: [adminEmail.toLowerCase()],
    contactName: '',
    contactPhone: '',
    remark: '',
    portalEmail: '',
    portalPassword: '',
    rates: { kind: 'blank' },
  };
}

export function changeCurrency(
  form: TenantForm,
  currency: Currency,
): TenantForm {
  return {
    ...form,
    currency,
    overdraftLimit: form.overdraftEdited
      ? form.overdraftLimit
      : defaultOverdraft(currency),
    // 只能复制同币种租户的费率表。
    rates:
      form.rates.kind === 'copy' && form.currency !== currency
        ? { kind: 'copy', source: null }
        : form.rates,
  };
}

/** 编码保存时转为大写；输入含小写时提示实际保存值。 */
export function normalizedCode(code: string) {
  const upper = code.trim().toUpperCase();
  return upper !== code.trim() && upper ? upper : null;
}

const emailSchema = z.email();

/**
 * 添加收件人：小写、去重，再限制 20 个。不合法的邮箱也先加入列表，
 * 在列表下方标出，便于对照修改（设计稿 4c）。
 */
export function addRecipients(
  emails: string[],
  raw: string,
  locale: Locale = currentLocale(),
): { emails: string[]; notice: string | null } {
  const next = [...emails];
  const notices: string[] = [];
  for (const part of raw.split(/[\s,，;；]+/)) {
    const email = part.trim().toLowerCase();
    if (!email) continue;
    if (next.includes(email)) {
      notices.push(
        translate(locale, 'admin:tenant.create.duplicateRecipient', { email }),
      );
      continue;
    }
    if (next.length >= maxRecipients) {
      notices.push(
        translate(locale, 'admin:tenant.create.maxRecipients', {
          max: maxRecipients,
        }),
      );
      break;
    }
    next.push(email);
  }
  return { emails: next, notice: notices[0] ?? null };
}

export function invalidRecipient(emails: string[]) {
  return emails.find((email) => !emailSchema.safeParse(email).success) ?? null;
}

export type TenantSubmission = {
  tenant: z.input<typeof adminTenantCreateRequestSchema>;
  portal: AdminPortalAccountCreateRequest;
};

/** 本地校验并组装两个请求；有错误时返回全部字段错误，不发送请求。 */
export function buildSubmission(
  form: TenantForm,
  locale: Locale = currentLocale(),
): { ok: true; value: TenantSubmission } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const code = form.code.trim();
  if (!code)
    errors.code = translate(locale, 'admin:tenant.create.codeRequired');
  else if (!/^[A-Za-z0-9]+$/.test(code))
    errors.code = translate(locale, 'admin:tenant.create.codeChars');
  else if (code.length > 64)
    errors.code = translate(locale, 'admin:tenant.create.codeTooLong');
  if (!form.name.trim())
    errors.name = translate(locale, 'admin:tenant.create.nameRequired');
  else if (form.name.trim().length > 200)
    errors.name = translate(locale, 'admin:tenant.create.nameTooLong');
  const overdraft = settingsAmountError(
    form.overdraftLimit,
    translate(locale, 'admin:tenant.fields.overdraftLimit'),
    'overdraft',
    locale,
  );
  if (overdraft) errors.overdraftLimit = overdraft;
  const threshold = settingsAmountError(
    form.lowBalanceThreshold,
    translate(locale, 'admin:tenant.fields.lowBalanceThreshold'),
    'amount',
    locale,
  );
  if (threshold) errors.lowBalanceThreshold = threshold;
  const badEmail = invalidRecipient(form.emails);
  if (badEmail)
    errors.emails = translate(locale, 'admin:tenant.create.invalidRecipient', {
      email: badEmail,
    });
  else if (form.emails.length > maxRecipients)
    errors.emails = translate(locale, 'admin:tenant.create.maxRecipients', {
      max: maxRecipients,
    });
  if (form.contactName.length > 200)
    errors.contactName = translate(
      locale,
      'admin:tenant.create.contactTooLong',
    );
  if (form.contactPhone.length > 100)
    errors.contactPhone = translate(locale, 'admin:tenant.create.phoneTooLong');
  if (form.remark.length > 2000)
    errors.remark = translate(locale, 'admin:tenant.create.remarkTooLong');
  if (!form.portalEmail.trim())
    errors.portalEmail = translate(
      locale,
      'admin:tenant.create.portalEmailRequired',
    );
  else if (!emailSchema.safeParse(form.portalEmail.trim()).success)
    errors.portalEmail = translate(
      locale,
      'admin:tenant.create.portalEmailInvalid',
    );
  if (
    form.portalPassword &&
    !newPasswordSchema.safeParse(form.portalPassword).success
  )
    errors.portalPassword = translate(
      locale,
      'admin:tenant.create.passwordLength',
    );
  if (form.rates.kind === 'csv' && !form.rates.file)
    errors.rates = translate(locale, 'admin:tenant.create.ratesFileRequired');
  if (form.rates.kind === 'copy' && !form.rates.source)
    errors.rates = translate(locale, 'admin:tenant.create.ratesSourceRequired');
  if (Object.keys(errors).length) return { ok: false, errors };

  const initialRates =
    form.rates.kind === 'csv' && form.rates.file
      ? { kind: 'csv' as const, file: form.rates.file }
      : form.rates.kind === 'copy' && form.rates.source
        ? {
            kind: 'copy' as const,
            sourceTenantId: form.rates.source.tenantId,
            sourceVersionId: form.rates.source.versionId,
          }
        : { kind: 'blank' as const };
  const tenant = {
    code,
    name: form.name.trim(),
    currency: form.currency,
    contactName: form.contactName.trim(),
    contactPhone: form.contactPhone.trim(),
    remark: form.remark.trim(),
    settings: {
      overdraftLimit: normalizeAmountInput(form.overdraftLimit),
      lowBalanceThreshold: normalizeAmountInput(form.lowBalanceThreshold),
      emails: form.emails,
    },
    initialRates,
  };
  const portal = {
    email: form.portalEmail.trim(),
    ...(form.portalPassword ? { initialPassword: form.portalPassword } : {}),
  };
  // 最后用共享契约整体复核，避免本地规则与契约漂移。
  if (
    !adminTenantCreateRequestSchema.safeParse(tenant).success ||
    !adminPortalAccountCreateRequestSchema.safeParse(portal).success
  )
    return {
      ok: false,
      errors: { form: translate(locale, 'admin:tenant.create.submitInvalid') },
    };
  return { ok: true, value: { tenant, portal } };
}

const serverFieldPrefixes: [string, FieldKey][] = [
  ['settings.overdraftLimit', 'overdraftLimit'],
  ['settings.lowBalanceThreshold', 'lowBalanceThreshold'],
  ['settings.emails', 'emails'],
  ['initialRates', 'rates'],
  ['code', 'code'],
  ['name', 'name'],
  ['contactName', 'contactName'],
  ['contactPhone', 'contactPhone'],
  ['remark', 'remark'],
];

/** 服务端 VALIDATION_ERROR 的字段路径映射回表单字段；无法归属的作为表单总提示。 */
export function serverFieldErrors(
  issues: ValidationIssue[],
  locale: Locale = currentLocale(),
): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.join('.');
    const field =
      serverFieldPrefixes.find(
        ([prefix]) => path === prefix || path.startsWith(`${prefix}.`),
      )?.[1] ?? 'form';
    if (!errors[field])
      errors[field] = issueText(issue, (key, params) =>
        translate(locale, key, params),
      );
  }
  return errors;
}
