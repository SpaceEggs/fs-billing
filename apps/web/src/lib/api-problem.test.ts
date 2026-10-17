import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './api';
import { apiProblem, fieldIssues, problemNotice } from './api-problem';

const failure = (status: number, code: string, extra: object = {}) =>
  new ApiRequestError(status, {
    error: { code, message: '服务端消息', requestId: 'req', ...extra },
  } as never);

describe('apiProblem', () => {
  it('500 INTERNAL_ERROR and 503 SERVICE_UNAVAILABLE show the same generic message', () => {
    const internal = problemNotice(apiProblem(failure(500, 'INTERNAL_ERROR')));
    const unavailable = problemNotice(
      apiProblem(failure(503, 'SERVICE_UNAVAILABLE')),
    );
    expect(internal).toEqual({
      title: '服务暂时不可用',
      body: '请稍后重试',
      refresh: false,
    });
    expect(unavailable).toEqual(internal);
  });

  it('CSV HTTP size errors retain the existing upload message', () => {
    expect(apiProblem(failure(413, 'CSV_LIMIT_EXCEEDED'))).toEqual({
      kind: 'csv-rejected',
      message: '文件超过 2 MB 或 10000 行上限',
    });
  });

  it('a network failure is also unavailable', () => {
    expect(apiProblem(new ApiRequestError(0, null))).toEqual({
      kind: 'unavailable',
    });
  });

  it('stale conflicts offer a refresh, unique conflicts do not', () => {
    expect(
      problemNotice(apiProblem(failure(409, 'SETTLEMENT_CONFLICT'))),
    ).toEqual({ title: '收款状态已变化，请刷新后重新确认', refresh: true });
    expect(problemNotice(apiProblem(failure(409, 'PREVIEW_EXPIRED')))).toEqual({
      title: '预览已过期，请重新预览',
      refresh: true,
    });
    expect(
      problemNotice(apiProblem(failure(409, 'TENANT_CODE_EXISTS'))),
    ).toEqual({ title: '租户编码已被使用', refresh: false });
  });

  it('429 keeps the retry-after seconds', () => {
    expect(
      problemNotice(
        apiProblem(failure(429, 'RATE_LIMITED', { retryAfterSeconds: 12 })),
      ),
    ).toEqual({
      title: '操作过于频繁',
      body: '请在 12 秒后重试',
      refresh: false,
    });
  });

  it('validation issues map to their field paths, first message wins', () => {
    const problem = apiProblem(
      failure(400, 'VALIDATION_ERROR', {
        issues: [
          { path: ['settings', 'emails', 1], message: '邮箱格式错误' },
          { path: ['reason'], message: '原因不能为空' },
          { path: ['reason'], message: '第二条' },
        ],
      }),
    );
    expect([...fieldIssues(problem)]).toEqual([
      ['settings.emails.1', '邮箱格式错误'],
      ['reason', '原因不能为空'],
    ]);
  });

  it('globally handled failures are distinguished from page errors', () => {
    expect(
      apiProblem(failure(401, 'SESSION_EXPIRED', { action: 'reauthenticate' })),
    ).toEqual({ kind: 'reauthenticate' });
    expect(apiProblem(failure(403, 'PASSWORD_CHANGE_REQUIRED'))).toEqual({
      kind: 'password-change-required',
    });
    expect(apiProblem(failure(404, 'NOT_FOUND'))).toEqual({
      kind: 'not-found',
    });
  });
});
