import type {
  AdminCsvRowError,
  ValidationIssue,
  adminConflictCodeSchema,
} from '@fs-billing/shared';
import type { z } from 'zod';
import { ApiRequestError, needsReauthentication } from './api';

export type ConflictCode = z.infer<typeof adminConflictCodeSchema>;

/**
 * 页面可处理的失败种类。401 reauthenticate 与 403 PASSWORD_CHANGE_REQUIRED
 * 由全局处理（登录过期对话框、改密页），页面只需不再显示内容。
 */
export type ApiProblem =
  | { kind: 'reauthenticate' }
  | { kind: 'password-change-required' }
  | { kind: 'blocked'; code: 'ACCOUNT_DISABLED' | 'IDENTITY_UNAVAILABLE' }
  | { kind: 'forbidden' }
  | { kind: 'validation'; issues: ValidationIssue[] }
  | { kind: 'csv-invalid'; rows: AdminCsvRowError[] }
  | { kind: 'csv-rejected'; message: string }
  | { kind: 'not-found' }
  | { kind: 'conflict'; code: ConflictCode; message: string }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

export const conflictMessages = {
  TENANT_CODE_EXISTS: '租户编码已被使用',
  EMAIL_EXISTS: '该邮箱已被其他账号使用',
  PORTAL_ACCOUNT_EXISTS: '该租户已有门户账号',
  CURRENCY_MISMATCH: '币种与租户币种不一致',
  IDEMPOTENCY_CONFLICT: '该操作已用不同内容提交过，请刷新后重新操作',
  RATE_VERSION_CONFLICT: '费率表已被修改，请刷新后重试',
  PREVIEW_STALE: '预览已失效，费率表可能已变化，请刷新后重新预览',
  PREVIEW_EXPIRED: '预览已过期，请重新预览',
  ALREADY_RECEIVED: '该笔已确认收款',
  RECEIVABLE_VOIDED: '该笔应收已作废',
  SETTLEMENT_CONFLICT: '收款状态已变化，请刷新后重新确认',
  RECEIVABLE_REVERSAL_MISMATCH: '冲正流水与该笔赊账不匹配',
  SELF_DISABLE: '不能停用自己的账号',
  LAST_ADMIN: '至少保留一个启用的管理员',
} as const satisfies Record<ConflictCode, string>;

/** 冲突说明页面数据已过时，刷新后可重新操作。 */
const staleConflicts: ReadonlySet<ConflictCode> = new Set([
  'IDEMPOTENCY_CONFLICT',
  'RATE_VERSION_CONFLICT',
  'PREVIEW_STALE',
  'PREVIEW_EXPIRED',
  'ALREADY_RECEIVED',
  'RECEIVABLE_VOIDED',
  'SETTLEMENT_CONFLICT',
]);

export function apiProblem(error: unknown): ApiProblem {
  if (needsReauthentication(error)) return { kind: 'reauthenticate' };
  if (!(error instanceof ApiRequestError) || !error.body)
    return { kind: 'unavailable' };
  const detail = error.body.error;
  switch (detail.code) {
    case 'PASSWORD_CHANGE_REQUIRED':
      return { kind: 'password-change-required' };
    case 'ACCOUNT_DISABLED':
    case 'IDENTITY_UNAVAILABLE':
      return { kind: 'blocked', code: detail.code };
    case 'FORBIDDEN':
      return { kind: 'forbidden' };
    case 'VALIDATION_ERROR':
      return { kind: 'validation', issues: detail.issues };
    case 'CSV_INVALID':
      return { kind: 'csv-invalid', rows: detail.rows };
    case 'CSV_ENCODING_UNSUPPORTED':
      return {
        kind: 'csv-rejected',
        message: '无法识别文件编码，请保存为 UTF-8 或 GBK 后重新上传',
      };
    case 'CSV_LIMIT_EXCEEDED':
      return {
        kind: 'csv-rejected',
        message: '文件超过 2 MB 或 10000 行上限',
      };
    case 'NOT_FOUND':
      return { kind: 'not-found' };
    case 'RATE_LIMITED':
    case 'ACCOUNT_LOCKED':
      return {
        kind: 'rate-limited',
        retryAfterSeconds: detail.retryAfterSeconds,
      };
    case 'TENANT_CODE_EXISTS':
    case 'EMAIL_EXISTS':
    case 'PORTAL_ACCOUNT_EXISTS':
    case 'CURRENCY_MISMATCH':
    case 'IDEMPOTENCY_CONFLICT':
    case 'RATE_VERSION_CONFLICT':
    case 'PREVIEW_STALE':
    case 'PREVIEW_EXPIRED':
    case 'ALREADY_RECEIVED':
    case 'RECEIVABLE_VOIDED':
    case 'SETTLEMENT_CONFLICT':
    case 'RECEIVABLE_REVERSAL_MISMATCH':
    case 'SELF_DISABLE':
    case 'LAST_ADMIN':
      return {
        kind: 'conflict',
        code: detail.code,
        message: conflictMessages[detail.code],
      };
    case 'UNAUTHENTICATED':
    case 'SESSION_EXPIRED':
    case 'INVALID_CREDENTIALS':
    case 'INTERNAL_ERROR':
    case 'SERVICE_UNAVAILABLE':
      return { kind: 'unavailable' };
  }
}

export type ProblemNotice = {
  title: string;
  body?: string;
  /** 服务端逐字段的校验信息，页面没有对应输入框时逐条列出。 */
  details?: string[];
  /** 冲突来自过时数据时提供“刷新”。 */
  refresh: boolean;
};

/** 表单或操作失败时的通用说明；500 与 503 统一为服务暂时不可用。 */
export function problemNotice(problem: ApiProblem): ProblemNotice {
  switch (problem.kind) {
    case 'validation':
      return {
        title: '提交内容有误，请检查标红的字段',
        details: [...new Set(problem.issues.map((issue) => issue.message))],
        refresh: false,
      };
    case 'csv-invalid':
      return {
        title: `CSV 有 ${problem.rows.length} 行错误，请修正后重新上传`,
        refresh: false,
      };
    case 'csv-rejected':
      return { title: problem.message, refresh: false };
    case 'conflict':
      return {
        title: problem.message,
        refresh: staleConflicts.has(problem.code),
      };
    case 'not-found':
      return {
        title: '内容不存在或已被删除',
        body: '请刷新后重试',
        refresh: true,
      };
    case 'rate-limited':
      return {
        title: '操作过于频繁',
        body: `请在 ${problem.retryAfterSeconds} 秒后重试`,
        refresh: false,
      };
    case 'forbidden':
      return { title: '没有权限执行此操作', refresh: false };
    case 'blocked':
      return { title: '该账号暂时无法使用', refresh: false };
    case 'reauthenticate':
      return { title: '登录已过期，请重新登录', refresh: false };
    case 'password-change-required':
      return { title: '请先修改初始或重置密码', refresh: false };
    case 'unavailable':
      return {
        title: '服务暂时不可用',
        body: '请稍后重试',
        refresh: false,
      };
  }
}

/** 按字段路径（如 `settings.emails.1`）取第一条服务端校验信息。 */
export function fieldIssues(problem: ApiProblem | null) {
  const fields = new Map<string, string>();
  if (problem?.kind !== 'validation') return fields;
  for (const issue of problem.issues) {
    const key = issue.path.join('.');
    if (!fields.has(key)) fields.set(key, issue.message);
  }
  return fields;
}
