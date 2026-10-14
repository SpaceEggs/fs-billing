import { describe, expect, it } from 'vitest';
import { apiErrorSchema } from '@fs-billing/shared';
import { ApiRequestError } from './api';
import { loginAlert, loginProblem } from './login-errors';

const now = Date.UTC(2026, 8, 29, 6, 0, 0);
const failure = (status: number, error: Record<string, unknown>) =>
  new ApiRequestError(
    status,
    apiErrorSchema.parse({
      error: { message: '请求失败', requestId: 'req-1', ...error },
    }),
  );

describe('login error mapping', () => {
  it('shows one message for every credential failure', () => {
    const invalid = loginAlert(
      'portal',
      loginProblem(failure(401, { code: 'INVALID_CREDENTIALS' }), now),
      now,
    );
    expect(invalid).toEqual({
      tone: 'neg',
      title: '登录邮箱或密码错误',
      body: '请检查后重新输入',
    });
    expect(
      loginAlert(
        'portal',
        loginProblem(
          failure(400, {
            code: 'VALIDATION_ERROR',
            issues: [{ path: ['body', 'email'], message: '请求字段格式错误' }],
          }),
          now,
        ),
        now,
      ),
    ).toEqual(invalid);
  });

  it('uses zone-specific copy for disabled accounts', () => {
    const problem = loginProblem(
      failure(403, { code: 'ACCOUNT_DISABLED' }),
      now,
    );
    expect(loginAlert('portal', problem, now)).toEqual({
      tone: 'neg',
      title: '该账号已停用',
      body: '如需恢复使用，请联系客服',
    });
    expect(loginAlert('admin', problem, now)).toEqual({
      tone: 'neg',
      title: '该管理员账号已停用',
      body: '如需恢复，请联系其他管理员启用',
    });
  });

  it('explains unusable identities', () => {
    const problem = loginProblem(
      failure(403, { code: 'IDENTITY_UNAVAILABLE' }),
      now,
    );
    expect(loginAlert('portal', problem, now)?.title).toBe(
      '该账号暂时无法使用',
    );
    expect(loginAlert('admin', problem, now)?.body).toBe(
      '请联系其他管理员处理',
    );
  });

  it('counts down the lock from retryAfterSeconds and clears when it ends', () => {
    const problem = loginProblem(
      failure(429, { code: 'ACCOUNT_LOCKED', retryAfterSeconds: 900 }),
      now,
    );
    expect(problem).toEqual({ kind: 'locked', retryAt: now + 900_000 });
    expect(loginAlert('portal', problem, now + 28_000)).toEqual({
      tone: 'warn',
      title: '登录失败次数过多，已暂时锁定',
      body: '请在 14分32秒 后重试',
      waitLabel: '请在 14分32秒 后重试',
    });
    expect(loginAlert('portal', problem, now + 900_000)).toBeNull();
  });

  it('distinguishes per-IP rate limits from account locks', () => {
    const problem = loginProblem(
      failure(429, { code: 'RATE_LIMITED', retryAfterSeconds: 60 }),
      now,
    );
    expect(loginAlert('admin', problem, now)).toEqual({
      tone: 'warn',
      title: '请求过于频繁',
      body: '请在 1分00秒 后重试',
      waitLabel: '请在 1分00秒 后重试',
    });
  });

  it('treats network and server failures as temporarily unavailable', () => {
    for (const error of [
      new ApiRequestError(0, null),
      failure(503, { code: 'SERVICE_UNAVAILABLE' }),
      failure(403, { code: 'FORBIDDEN' }),
      new TypeError('boom'),
    ])
      expect(loginAlert('portal', loginProblem(error, now), now)).toEqual({
        tone: 'neg',
        title: '暂时无法登录',
        body: '服务暂时不可用，请稍后重试',
      });
  });
});
