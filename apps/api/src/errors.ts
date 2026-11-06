import { DatabaseUnavailableError } from '@fs-billing/db';
import {
  apiErrorSchema,
  apiErrorStatus,
  translate,
  type ApiErrorCode,
  type ValidationIssue,
} from '@fs-billing/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

const VALIDATION_KEY_PREFIX = 'errors:';

/**
 * 校验问题：`key` 是文案目录键，`message` 是保留到 I9 的中文原文。
 * 目录只放在 shared，这里用纯查表得到中文，不依赖语言运行时。
 */
export function validationIssue(
  path: ValidationIssue['path'],
  key: string,
  params?: ValidationIssue['params'],
): ValidationIssue {
  return {
    path,
    key,
    ...(params === undefined ? {} : { params }),
    message: translate('zh', key, params),
  };
}

type ZodIssueLike = {
  readonly path: readonly PropertyKey[];
  readonly message: string;
  readonly params?: Readonly<Record<string, unknown>> | undefined;
};

/** 把 Zod 的自定义消息（已是目录键）转成契约里的校验问题；内置英文消息用通用键。 */
export function validationIssues(error: {
  readonly issues: readonly ZodIssueLike[];
}): ValidationIssue[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((part) =>
      typeof part === 'number' ? part : String(part),
    );
    const key = issue.message.startsWith(VALIDATION_KEY_PREFIX)
      ? issue.message
      : 'errors:validation.field.invalid';
    const params = issue.params as ValidationIssue['params'] | undefined;
    return validationIssue(path, key, params);
  });
}

const transientCodes = new Set([
  '40001',
  '40P01',
  '57P01',
  '57P02',
  '57P03',
  '53300',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'EAI_AGAIN',
]);

export function isTransientServiceError(error: unknown): boolean {
  const seen = new Set<Error>();
  for (
    let current = error;
    current instanceof Error && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    if (current instanceof DatabaseUnavailableError) return true;
    if (
      'code' in current &&
      typeof current.code === 'string' &&
      (/^08[0-9A-Z]{3}$/.test(current.code) || transientCodes.has(current.code))
    )
      return true;
  }
  return false;
}

const messages: Record<ApiErrorCode, string> = {
  UNAUTHENTICATED: 'Authentication required',
  SESSION_EXPIRED: 'Session expired',
  INVALID_CREDENTIALS: 'Invalid credentials',
  FORBIDDEN: 'Forbidden',
  ACCOUNT_DISABLED: 'Account disabled',
  IDENTITY_UNAVAILABLE: 'Identity unavailable',
  PASSWORD_CHANGE_REQUIRED: 'Password change required',
  ACCOUNT_LOCKED: 'Account locked',
  VALIDATION_ERROR: 'Invalid request',
  NOT_FOUND: 'Not found',
  RATE_LIMITED: 'Rate limit exceeded',
  SERVICE_UNAVAILABLE: 'Service unavailable',
  INTERNAL_ERROR: 'Internal server error',
};
export class ApiFailure extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly retryAfterSeconds?: number,
    readonly issues?: ValidationIssue[],
  ) {
    super(code);
  }
}
export function sendFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  failure: ApiFailure,
) {
  const extra =
    failure.code === 'UNAUTHENTICATED' || failure.code === 'SESSION_EXPIRED'
      ? { action: 'reauthenticate' }
      : failure.code === 'ACCOUNT_LOCKED' || failure.code === 'RATE_LIMITED'
        ? { retryAfterSeconds: failure.retryAfterSeconds ?? 1 }
        : failure.code === 'VALIDATION_ERROR'
          ? {
              issues: failure.issues ?? [
                validationIssue([], 'errors:validation.request.invalid'),
              ],
            }
          : {};
  const body = apiErrorSchema.parse({
    error: {
      code: failure.code,
      message: messages[failure.code],
      requestId: request.id,
      ...extra,
    },
  });
  reply.header('Cache-Control', 'no-store');
  if ('retryAfterSeconds' in body.error)
    reply.header('Retry-After', body.error.retryAfterSeconds);
  return reply.code(apiErrorStatus[failure.code]).send(body);
}
