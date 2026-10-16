import { z } from 'zod';
import {
  adminAccountCreateRequestSchema,
  adminPortalAccountCreateRequestSchema,
  newPasswordSchema,
  type AdminAccountCreateRequest,
  type AdminPortalAccountCreateRequest,
} from '@fs-billing/shared';
import { ApiRequestError } from './api';
import { fieldIssues, type ApiProblem } from './api-problem';

export type AccountField = 'name' | 'email' | 'initialPassword';
export type AccountFieldErrors = Partial<Record<AccountField, string>>;

const emailSchema = z.email();

function emailError(email: string) {
  if (!email) return '请输入登录邮箱';
  if (!emailSchema.safeParse(email).success) return '邮箱格式不正确';
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
    : { ok: false, errors: { email: '提交内容有误，请检查后重试' } };
}

export function buildAdminCreate(form: { name: string; email: string }) {
  const name = form.name.trim();
  const email = form.email.trim();
  const errors: AccountFieldErrors = {};
  if (!name) errors.name = '请输入姓名';
  else if (name.length > 200) errors.name = '姓名最多 200 个字符';
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
    errors.initialPassword = '初始密码须为 8 到 128 位';
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
