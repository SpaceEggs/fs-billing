import type {
  AdminCsvRowError,
  AdminMailSettingsErrorCode,
  ValidationIssue,
  adminConflictCodeSchema,
} from '@fs-billing/shared';
import type { z } from 'zod';
import { i18n } from '../i18n';
import { ApiRequestError, needsReauthentication } from './api';

export type ConflictCode = z.infer<typeof adminConflictCodeSchema>;

/** 目录翻译函数；shared 只放目录数据，这里由 web 的 i18next 实例提供实现。 */
export type Translator = (
  key: string,
  params?: Record<string, unknown>,
) => string;

const translate: Translator = (key, params) =>
  i18n.t(key, (params ?? {}) as never) as unknown as string;

type TranslatableIssue = {
  readonly key?: unknown;
  readonly params?: unknown;
  readonly message: string;
};

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
  | {
      kind: 'mail-settings';
      code: AdminMailSettingsErrorCode;
      message: string;
    }
  | { kind: 'rate-limited'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

/** 校验问题优先按目录键取文案；没有键（旧响应、库内业务错误）回落中文原文。 */
export function issueText(
  issue: TranslatableIssue,
  t: Translator = translate,
): string {
  if (typeof issue.key === 'string')
    return t(issue.key, issue.params as Record<string, unknown> | undefined);
  // 客户端直接用 shared schema 校验时，Zod issue 只有 message（可能是目录键）。
  if (issue.message.startsWith('errors:'))
    return t(
      issue.message,
      issue.params as Record<string, unknown> | undefined,
    );
  return issue.message;
}

/** CSV 行错误按目录键取文案。 */
export function csvRowText(
  row: AdminCsvRowError,
  t: Translator = translate,
): string {
  return t(row.key, row.params);
}

/** 冲突、邮箱设置与 CSV 拒绝的说明。 */
export function problemText(
  problem: ApiProblem,
  t: Translator = translate,
): string | null {
  switch (problem.kind) {
    case 'conflict':
      return t(`errors:conflict.${problem.code}`);
    case 'mail-settings':
      return t(`errors:mailSettings.${problem.code}`);
    case 'csv-rejected':
      return problem.message;
    default:
      return null;
  }
}

/** 冲突说明页面数据已过时，刷新后可重新操作。 */
const staleConflicts: ReadonlySet<ConflictCode> = new Set([
  'PORTAL_ACCOUNT_EXISTS',
  'IDEMPOTENCY_CONFLICT',
  'RATE_VERSION_CONFLICT',
  'PREVIEW_STALE',
  'PREVIEW_EXPIRED',
  'ALREADY_RECEIVED',
  'RECEIVABLE_VOIDED',
  'SETTLEMENT_CONFLICT',
  'STATEMENT_VERSION_CONFLICT',
  'UNASSIGNED_PREVIEW_STALE',
  'UNASSIGNED_NOTHING_TO_ASSIGN',
  'CDR_MONTH_NOT_DELETABLE',
  'CDR_DELETE_COUNT_CHANGED',
  'ALERT_SETTINGS_VERSION_CONFLICT',
  'MAIL_SETTINGS_VERSION_CONFLICT',
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
        message: translate('errors:csvRejected.encodingUnsupported'),
      };
    case 'CSV_LIMIT_EXCEEDED':
      return {
        kind: 'csv-rejected',
        message: translate('errors:csvRejected.limitExceeded'),
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
    case 'STATEMENT_DETAILS_DELETED':
    case 'STATEMENT_NOT_FINAL':
    case 'STATEMENT_VERSION_CONFLICT':
    case 'UNASSIGNED_PREVIEW_STALE':
    case 'UNASSIGNED_NOTHING_TO_ASSIGN':
    case 'CDR_MONTH_NOT_DELETABLE':
    case 'CDR_DELETE_COUNT_CHANGED':
    case 'ALERT_SETTINGS_VERSION_CONFLICT':
    case 'MAIL_SETTINGS_VERSION_CONFLICT':
      return {
        kind: 'conflict',
        code: detail.code,
        message: translate(`errors:conflict.${detail.code}`),
      };
    case 'SETTINGS_KEY_MISSING':
    case 'MAIL_SETTINGS_PASSWORD_REQUIRED':
    case 'MAIL_SETTINGS_PASSWORD_UNUSABLE':
    case 'MAIL_SETTINGS_HOST_NOT_ALLOWED':
      return {
        kind: 'mail-settings',
        code: detail.code,
        message: translate(`errors:mailSettings.${detail.code}`),
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
        details: [...new Set(problem.issues.map((issue) => issueText(issue)))],
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
    case 'mail-settings':
      return { title: problem.message, refresh: false };
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
    if (!fields.has(key)) fields.set(key, issueText(issue));
  }
  return fields;
}
