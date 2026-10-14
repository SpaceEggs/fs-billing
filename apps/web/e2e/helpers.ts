import { expect, type Page } from '@playwright/test';
import { password } from './accounts';

/** 提交登录表单并等待接口响应，避免读到上一次请求留下的提示。 */
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
