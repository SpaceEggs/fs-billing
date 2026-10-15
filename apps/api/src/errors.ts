import { DatabaseUnavailableError } from '@fs-billing/db';
import {
  apiErrorSchema,
  apiErrorStatus,
  type ApiErrorCode,
  type ValidationIssue,
} from '@fs-billing/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';

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
  UNAUTHENTICATED: '请先登录',
  SESSION_EXPIRED: '登录已过期',
  INVALID_CREDENTIALS: '账号或密码错误',
  FORBIDDEN: '没有访问权限',
  ACCOUNT_DISABLED: '账号已停用',
  IDENTITY_UNAVAILABLE: '身份暂不可用',
  PASSWORD_CHANGE_REQUIRED: '请先修改初始或重置密码',
  ACCOUNT_LOCKED: '账号暂时锁定',
  VALIDATION_ERROR: '请求格式错误',
  NOT_FOUND: '资源不存在',
  RATE_LIMITED: '请求过于频繁',
  SERVICE_UNAVAILABLE: '服务暂不可用',
  INTERNAL_ERROR: '服务内部错误',
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
              issues: failure.issues ?? [{ path: [], message: '请求格式错误' }],
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
