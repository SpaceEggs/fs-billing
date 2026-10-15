import { expect, test, type Page, type Response } from '@playwright/test';
import { password } from './accounts';

type CredentialResponse = Pick<Response, 'status' | 'headers' | 'json'>;

const maxRateLimitRetries = 3;
const maxRetryAfterSeconds = 60;

/**
 * 登录与改密共享每 IP 每分钟 30 次的凭据限流；本地复用的 API 进程可能已被上一轮用掉额度。
 * 遇 429 RATE_LIMITED 按 Retry-After 等待后重发，最多 3 次；ACCOUNT_LOCKED 不重试。
 * `beforeWait` 供用例延长自身超时。
 */
export async function retryRateLimited<R extends CredentialResponse>(
  send: () => Promise<R>,
  beforeWait: (waitMs: number) => void = extendTestTimeout,
): Promise<R> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send();
    if (response.status() !== 429 || attempt === maxRateLimitRetries)
      return response;
    const body = (await response.json()) as {
      error?: { code?: string; retryAfterSeconds?: number };
    };
    const seconds = Number(
      response.headers()['retry-after'] ?? body.error?.retryAfterSeconds,
    );
    if (
      body.error?.code !== 'RATE_LIMITED' ||
      !(seconds > 0 && seconds <= maxRetryAfterSeconds)
    )
      return response;
    const waitMs = seconds * 1000 + 250;
    beforeWait(waitMs);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

function extendTestTimeout(waitMs: number) {
  const info = test.info();
  info.setTimeout(info.timeout + waitMs);
}

/** 点击提交并等待该凭据接口的响应，遇限流时重新点击。 */
export function submitCredentials(
  page: Page,
  path: '/api/auth/login' | '/api/auth/change-password',
  submit: () => Promise<void>,
) {
  return retryRateLimited(async () => {
    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === path &&
        candidate.request().method() === 'POST',
    );
    await submit();
    return response;
  });
}

/** 提交登录表单并返回本次接口响应；调用方据此等待对应提示出现。 */
export async function submitLogin(
  page: Page,
  email: string,
  secret = password(),
) {
  await page.getByLabel('登录邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill(secret);
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === '/api/auth/login' &&
      candidate.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '登录', exact: true }).click();
  return response;
}

export async function errorCode(response: Response) {
  const body = (await response.json()) as { error?: { code?: string } };
  return body.error?.code ?? null;
}

/**
 * 等本次登录请求结束（按钮恢复可用）后再断言提示。
 * 只看到响应还不够：React 可能尚未提交新提示，连续两次相同错误时会读到上一次的文字。
 */
export async function expectSettledAlert(page: Page, text: string) {
  await expect(
    page.getByRole('button', { name: '登录', exact: true }),
  ).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveText(text);
}

export async function loginAs(
  page: Page,
  path: '/login' | '/admin/login',
  email: string,
) {
  await page.goto(path);
  await submitLogin(page, email);
}

export async function expectPath(page: Page, pathWithSearch: string) {
  await expect
    .poll(() => {
      const url = new URL(page.url());
      return `${url.pathname}${url.search}`;
    })
    .toBe(pathWithSearch);
}
