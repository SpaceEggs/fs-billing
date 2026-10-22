import { expect, type Browser, type Page } from '@playwright/test';
import { webOrigin } from './env';
import { expectPath, submitLogin } from './helpers';

/**
 * 为本次运行专用的租户开通门户账号，用临时密码改密后返回已登录的客户页面。
 * `password` 是改密后的密码，登录过期用例用它重新登录。
 */
export async function openPortalCustomer(
  admin: Page,
  browser: Browser,
  tenant: { id: string; code: string },
  options: { viewport?: { width: number; height: number } } = {},
) {
  const email = `${tenant.code.toLowerCase()}@example.com`;
  const created = await admin.request.post(
    `/api/admin/tenants/${tenant.id}/portal-accounts`,
    { data: { email } },
  );
  expect(created.status()).toBe(200);
  const { temporaryPassword } = (await created.json()) as {
    temporaryPassword: string;
  };
  const password = `New-${temporaryPassword}`;
  const context = await browser.newContext({
    baseURL: webOrigin,
    ...(options.viewport ? { viewport: options.viewport } : {}),
  });
  const page = await context.newPage();
  await page.goto('/login');
  await submitLogin(page, email, temporaryPassword);
  await expectPath(page, '/change-password');
  await page.getByLabel('当前密码', { exact: true }).fill(temporaryPassword);
  await page.getByLabel('新密码', { exact: true }).fill(password);
  await page.getByLabel('确认新密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '修改密码' }).click();
  await expectPath(page, '/');
  return { page, context, email, password };
}
