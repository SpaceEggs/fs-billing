import { ApiRequestError } from './api';
import { formatDuration } from './format';
import type { Zone } from './zone';

export type LoginProblem =
  | { kind: 'invalid-credentials' }
  | { kind: 'account-disabled' }
  | { kind: 'identity-unavailable' }
  | { kind: 'locked'; retryAt: number }
  | { kind: 'rate-limited'; retryAt: number }
  | { kind: 'unavailable' };

/** 把登录接口的错误代码映射为页面状态；未知邮箱与密码错误同属一个状态。 */
export function loginProblem(error: unknown, now: number): LoginProblem {
  if (!(error instanceof ApiRequestError) || !error.body)
    return { kind: 'unavailable' };
  const detail = error.body.error;
  switch (detail.code) {
    case 'INVALID_CREDENTIALS':
    case 'VALIDATION_ERROR':
      return { kind: 'invalid-credentials' };
    case 'ACCOUNT_DISABLED':
      return { kind: 'account-disabled' };
    case 'IDENTITY_UNAVAILABLE':
      return { kind: 'identity-unavailable' };
    case 'ACCOUNT_LOCKED':
      return { kind: 'locked', retryAt: now + detail.retryAfterSeconds * 1000 };
    case 'RATE_LIMITED':
      return {
        kind: 'rate-limited',
        retryAt: now + detail.retryAfterSeconds * 1000,
      };
    default:
      return { kind: 'unavailable' };
  }
}

export type LoginAlert = {
  tone: 'neg' | 'warn';
  title: string;
  body: string;
  /** 等待期间替换登录按钮文字并禁用表单。 */
  waitLabel?: string;
};

const contact = {
  portal: { disabled: '如需恢复使用，请联系客服', other: '请联系客服处理' },
  admin: {
    disabled: '如需恢复，请联系其他管理员启用',
    other: '请联系其他管理员处理',
  },
} as const satisfies Record<Zone, { disabled: string; other: string }>;

/** 返回 null 表示没有提示（包括锁定已到期）。 */
export function loginAlert(
  zone: Zone,
  problem: LoginProblem | null,
  now: number,
): LoginAlert | null {
  if (!problem) return null;
  switch (problem.kind) {
    case 'invalid-credentials':
      return {
        tone: 'neg',
        title: '登录邮箱或密码错误',
        body: '请检查后重新输入',
      };
    case 'account-disabled':
      return {
        tone: 'neg',
        title: zone === 'admin' ? '该管理员账号已停用' : '该账号已停用',
        body: contact[zone].disabled,
      };
    case 'identity-unavailable':
      return {
        tone: 'neg',
        title: '该账号暂时无法使用',
        body: contact[zone].other,
      };
    case 'locked':
    case 'rate-limited': {
      const remaining = (problem.retryAt - now) / 1000;
      if (remaining <= 0) return null;
      const waitLabel = `请在 ${formatDuration(remaining)} 后重试`;
      return {
        tone: 'warn',
        title:
          problem.kind === 'locked'
            ? '登录失败次数过多，已暂时锁定'
            : '请求过于频繁',
        body: waitLabel,
        waitLabel,
      };
    }
    case 'unavailable':
      return {
        tone: 'neg',
        title: '暂时无法登录',
        body: '服务暂时不可用，请稍后重试',
      };
  }
}
