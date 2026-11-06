import { translate } from '@fs-billing/shared';
import { currentLocale } from '../i18n';
import { ApiRequestError } from './api';
import { formatDuration } from './duration';
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
  portal: {
    disabled: 'auth:login.accountDisabled.portalBody',
    other: 'auth:login.identityUnavailable.portalBody',
  },
  admin: {
    disabled: 'auth:login.accountDisabled.adminBody',
    other: 'auth:login.identityUnavailable.adminBody',
  },
} as const satisfies Record<Zone, { disabled: string; other: string }>;

/** 返回 null 表示没有提示（包括锁定已到期）。 */
export function loginAlert(
  zone: Zone,
  problem: LoginProblem | null,
  now: number,
): LoginAlert | null {
  if (!problem) return null;
  const locale = currentLocale();
  const t = (key: string, params?: Record<string, unknown>) =>
    translate(locale, key, params);
  switch (problem.kind) {
    case 'invalid-credentials':
      return {
        tone: 'neg',
        title: t('auth:login.invalidCredentials.title'),
        body: t('auth:login.invalidCredentials.body'),
      };
    case 'account-disabled':
      return {
        tone: 'neg',
        title:
          zone === 'admin'
            ? t('auth:login.accountDisabled.adminTitle')
            : t('auth:login.accountDisabled.portalTitle'),
        body: t(contact[zone].disabled),
      };
    case 'identity-unavailable':
      return {
        tone: 'neg',
        title: t('auth:login.identityUnavailable.title'),
        body: t(contact[zone].other),
      };
    case 'locked':
    case 'rate-limited': {
      const remaining = (problem.retryAt - now) / 1000;
      if (remaining <= 0) return null;
      const waitLabel = t('auth:login.retryAfter', {
        duration: formatDuration(remaining, locale),
      });
      return {
        tone: 'warn',
        title:
          problem.kind === 'locked'
            ? t('auth:login.locked.title')
            : t('auth:login.rateLimited.title'),
        body: waitLabel,
        waitLabel,
      };
    }
    case 'unavailable':
      return {
        tone: 'neg',
        title: t('auth:login.unavailable.title'),
        body: t('auth:login.unavailable.body'),
      };
  }
}
