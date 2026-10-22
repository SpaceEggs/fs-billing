import { expect, test as base } from '@playwright/test';
import { accounts } from './accounts';
import { createTenant, test as adminTest, uniqueCode } from './admin';
import { webOrigin } from './env';
import { expectPath, loginAs } from './helpers';

base('shows the read-only account facts', async ({ page }) => {
  await loginAs(page, '/login', accounts.customer);
  await expectPath(page, '/');
  await page.goto('/portal/settings');

  await expect(page.getByRole('heading', { name: '账号设置' })).toBeVisible();
  const facts = page.getByRole('region', { name: '账号信息' });
  await expect(facts).toContainText(accounts.customer);
  await expect(facts).toContainText('深圳市某某科技有限公司');
  await expect(facts).toContainText('ABC001');
  await expect(facts).toContainText('CNY 人民币');
  await expect(facts.getByRole('textbox')).toHaveCount(0);
});

adminTest(
  'changes the password and keeps the page',
  async ({ page, browser, playwright }) => {
    const tenant = await createTenant(page, { code: uniqueCode('SET') });
    const email = `${tenant.code.toLowerCase()}@example.com`;
    const created = await page.request.post(
      `/api/admin/tenants/${tenant.id}/portal-accounts`,
      { data: { email } },
    );
    expect(created.status()).toBe(200);
    const { temporaryPassword } = (await created.json()) as {
      temporaryPassword: string;
    };

    const customer = await browser.newPage({
      storageState: { cookies: [], origins: [] },
    });
    await customer.goto('/login');
    await customer.getByLabel('登录邮箱').fill(email);
    await customer.getByLabel('密码', { exact: true }).fill(temporaryPassword);
    await customer.getByRole('button', { name: '登录', exact: true }).click();
    await expectPath(customer, '/change-password');
    const forcedPassword = `Forced-${temporaryPassword}`;
    await customer
      .getByLabel('当前密码', { exact: true })
      .fill(temporaryPassword);
    await customer.getByLabel('新密码', { exact: true }).fill(forcedPassword);
    await customer
      .getByLabel('确认新密码', { exact: true })
      .fill(forcedPassword);
    await customer.getByRole('button', { name: '修改密码' }).click();
    await expectPath(customer, '/');

    await customer.goto('/portal/settings');
    const form = customer.getByRole('form', { name: '修改密码' });
    await expect(form.getByText('管理员提供的临时密码')).toHaveCount(0);

    await form.getByLabel('当前密码', { exact: true }).fill('wrong-password');
    await form.getByLabel('新密码', { exact: true }).fill('Another-Pass-9');
    await form.getByLabel('确认新密码', { exact: true }).fill('Another-Pass-9');
    await form.getByRole('button', { name: '修改密码' }).click();
    await expect(form.getByText('当前密码不正确')).toBeVisible();

    const nextPassword = 'Another-Pass-9';
    await form.getByLabel('当前密码', { exact: true }).fill(forcedPassword);
    await form.getByRole('button', { name: '修改密码' }).click();
    await expect(
      customer.getByRole('status').filter({ hasText: '密码已修改' }),
    ).toContainText('其他设备上的登录将失效');
    await expectPath(customer, '/portal/settings');
    await expect(form.getByLabel('当前密码', { exact: true })).toHaveValue('');

    await customer.reload();
    await expect(
      customer.getByRole('heading', { name: '账号设置' }),
    ).toBeVisible();

    const fresh = await playwright.request.newContext({
      baseURL: webOrigin,
    });
    const oldLogin = await fresh.post('/api/auth/login', {
      data: { email, password: forcedPassword },
    });
    expect(oldLogin.status()).toBe(401);
    const newLogin = await fresh.post('/api/auth/login', {
      data: { email, password: nextPassword },
    });
    expect(newLogin.status()).toBe(200);
    await fresh.dispose();
    await customer.close();
  },
);
