import { expect, type Page, type Response } from '@playwright/test';
import { password } from './accounts';

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
