import { z } from 'zod';
import {
  adminAccountCreateRequestSchema,
  adminPortalAccountCreateRequestSchema,
  newPasswordSchema,
  translate,
  type AdminAccountCreateRequest,
  type AdminPortalAccountCreateRequest,
} from '@fs-billing/shared';
import { currentLocale } from '../i18n';
import { ApiRequestError } from './api';
import { fieldIssues, type ApiProblem } from './api-problem';

export type AccountField = 'name' | 'email' | 'initialPassword';
export type AccountFieldErrors = Partial<Record<AccountField, string>>;

const emailSchema = z.email();

const t = (key: string, params?: Record<string, unknown>) =>
  translate(currentLocale(), key, params);

function emailError(email: string) {
  if (!email) return t('errors:form.emailRequired');
  if (!emailSchema.safeParse(email).success)
    return t('errors:form.emailInvalid');
  return undefined;
}

function result<Request>(
  errors: AccountFieldErrors,
  request: Request,
  schema: z.ZodType<Request>,
): { ok: true; request: Request } | { ok: false; errors: AccountFieldErrors } {
  if (Object.keys(errors).length) return { ok: false, errors };
  // 最后用共享契约复核，避免本地规则与契约漂移。
  const parsed = schema.safeParse(request);
  return parsed.success
    ? { ok: true, request: parsed.data }
    : { ok: false, errors: { email: t('errors:form.submitInvalid') } };
}

export function buildAdminCreate(form: { name: string; email: string }) {
  const name = form.name.trim();
  const email = form.email.trim();
  const errors: AccountFieldErrors = {};
  if (!name) errors.name = t('errors:form.nameRequired');
  else if (name.length > 200)
    errors.name = t('errors:form.nameTooLong', { max: 200 });
  const emailMessage = emailError(email);
  if (emailMessage) errors.email = emailMessage;
  return result<AdminAccountCreateRequest>(
    errors,
    { name, email },
    adminAccountCreateRequestSchema,
  );
}

/** 初始密码留空时由服务端生成临时密码；填写时原样提交，不去除空格。 */
export function buildPortalCreate(form: {
  email: string;
  initialPassword: string;
}) {
  const email = form.email.trim();
  const errors: AccountFieldErrors = {};
  const emailMessage = emailError(email);
  if (emailMessage) errors.email = emailMessage;
  if (
    form.initialPassword &&
    !newPasswordSchema.safeParse(form.initialPassword).success
  )
    errors.initialPassword = t('errors:form.passwordLength', {
      min: 8,
      max: 128,
    });
  return result<AdminPortalAccountCreateRequest>(
    errors,
    {
      email,
      ...(form.initialPassword
        ? { initialPassword: form.initialPassword }
        : {}),
    },
    adminPortalAccountCreateRequestSchema,
  );
}

/** 服务端 VALIDATION_ERROR 中属于表单字段的信息；其余由失败说明列出。 */
export function serverAccountErrors(problem: ApiProblem | null) {
  const issues = fieldIssues(problem);
  const errors: AccountFieldErrors = {};
  for (const field of ['name', 'email', 'initialPassword'] as const) {
    const message = issues.get(field);
    if (message) errors[field] = message;
  }
  return errors;
}

/**
 * 没有拿到可解析的服务端答复（网络中断、网关错误页、响应不符合契约）：
 * 写操作可能已经生效，不能当作失败直接重试。
 */
export function outcomeUnknown(error: unknown) {
  return !(error instanceof ApiRequestError) || error.body === null;
}
