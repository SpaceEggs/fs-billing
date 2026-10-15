import { expect, type Browser, type Page } from '@playwright/test';
import { accounts } from './accounts';
import { createTenant, test, uniqueCode } from './admin';
import { webOrigin } from './env';
import { expectPath, submitLogin } from './helpers';

/** 每次运行用新邮箱；从不停用其他用例登录用的种子管理员。 */
function uniqueEmail(prefix: string) {
  return `${uniqueCode(prefix).toLowerCase()}@example.com`;
}

async function openAdmins(page: Page, email: string) {
  await page.goto('/admin');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '管理员' })
    .click();
  await expectPath(page, '/admin/admins');
  await page.getByRole('searchbox', { name: '搜索姓名或邮箱' }).fill(email);
  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toHaveCount(1);
  return row;
}

async function createAdmin(page: Page, name: string, email: string) {
  const response = await page.request.post('/api/admin/admins', {
    data: { name, email },
  });
  expect(response.status()).toBe(200);
}

/** 用临时密码在全新会话登录，应被要求先修改密码。 */
async function expectTemporaryLogin(
  browser: Browser,
  path: '/login' | '/admin/login',
  email: string,
  secret: string,
) {
  const context = await browser.newContext({ baseURL: webOrigin });
  const page = await context.newPage();
  await page.goto(path);
  const response = await submitLogin(page, email, secret);
  expect(response.status()).toBe(200);
  await expectPath(
    page,
    path === '/login' ? '/change-password' : '/admin/change-password',
  );
  await context.close();
}

test('shows temporary password once', async ({ page, browser }) => {
  const email = uniqueEmail('ADM');
  await page.goto('/admin/admins');
  await page.getByRole('button', { name: '＋ 新增管理员' }).click();
  const form = page.getByRole('form', { name: '新增管理员' });
  await form.getByLabel(/姓名/).fill('端到端管理员');
  await form.getByLabel(/登录邮箱/).fill(email);
  await form.getByRole('button', { name: '创建并生成临时密码' }).click();

  const result = page.getByRole('dialog', {
    name: '已创建管理员 端到端管理员',
  });
  const field = result.getByRole('textbox', { name: '临时密码', exact: true });
  await expect(field).toBeVisible();
  const temporary = await field.inputValue();
  expect(temporary.length).toBeGreaterThanOrEqual(8);
  await expect(result.getByText('关闭后无法再次查看')).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(result).toBeVisible();
  await result.getByRole('button', { name: '我已复制，关闭' }).click();
  await expect(result).toBeHidden();
  await expect(
    page.getByRole('button', { name: '＋ 新增管理员' }),
  ).toBeFocused();

  const row = await openAdmins(page, email);
  await expect(row).toContainText('端到端管理员');
  await expect(row).toContainText('从未登录');
  await expect(page.getByText(temporary)).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText(temporary)).toHaveCount(0);

  await expectTemporaryLogin(browser, '/admin/login', email, temporary);
});

test('blocks self disable', async ({ page }) => {
  const row = await openAdmins(page, accounts.admin);
  await expect(row.getByText('你', { exact: true })).toBeVisible();
  const disable = row.getByRole('button', { name: /^停用 / });
  await expect(disable).toBeDisabled();
  await expect(disable).toHaveAccessibleDescription('不能停用自己的账号');
  await expect(
    row.getByRole('button', { name: /^重置 .* 的密码$/ }),
  ).toBeEnabled();
});

test('resets, disables and enables another admin', async ({
  page,
  browser,
}) => {
  const email = uniqueEmail('ADS');
  const name = `停用测试${uniqueCode('').slice(-4)}`;
  await createAdmin(page, name, email);
  const row = await openAdmins(page, email);

  const resetButton = row.getByRole('button', { name: `重置 ${name} 的密码` });
  await resetButton.click();
  const confirm = page.getByRole('dialog', { name: `重置 ${name} 的密码？` });
  await confirm.getByRole('button', { name: '取消' }).click();
  await expect(confirm).toBeHidden();
  await expect(resetButton).toBeFocused();
  await resetButton.click();
  await confirm.getByRole('button', { name: '重置密码' }).click();
  const result = page.getByRole('dialog', {
    name: `已为 ${name} 生成临时密码`,
  });
  const temporary = await result
    .getByRole('textbox', { name: '临时密码', exact: true })
    .inputValue();
  await result.getByRole('button', { name: '我已复制，关闭' }).click();
  await expect(result).toBeHidden();
  await expect(resetButton).toBeFocused();
  await expectTemporaryLogin(browser, '/admin/login', email, temporary);

  await row.getByRole('button', { name: `停用 ${name}` }).click();
  const disable = page.getByRole('dialog', { name: `停用管理员 ${name}？` });
  await expect(disable).toContainText('立即退出登录');
  await disable.getByRole('button', { name: '停用', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(
    `已停用管理员 ${name}，已记入操作日志`,
  );
  await expect(row).toContainText('已停用');

  await row.getByRole('button', { name: `启用 ${name}` }).click();
  await page
    .getByRole('dialog', { name: `启用管理员 ${name}？` })
    .getByRole('button', { name: '启用', exact: true })
    .click();
  await expect(page.getByRole('status')).toHaveText(
    `已启用管理员 ${name}，已记入操作日志`,
  );
  await expect(row.getByRole('button', { name: `停用 ${name}` })).toBeEnabled();
});

test('opens a missing portal account from the portal tab', async ({
  page,
  browser,
}) => {
  const tenant = await createTenant(page);
  const email = `${tenant.code.toLowerCase()}@example.com`;
  await page.goto(`/admin/tenants/${tenant.id}?tab=portal`);
  await page.getByRole('button', { name: '开通门户账号' }).click();
  const form = page.getByRole('form', { name: '开通门户账号' });
  await form.getByLabel(/登录邮箱/).fill(email);
  await form.getByRole('button', { name: '开通' }).click();
  const result = page.getByRole('dialog', { name: '门户账号已开通' });
  const temporary = await result
    .getByRole('textbox', { name: '临时密码', exact: true })
    .inputValue();
  await result.getByRole('button', { name: '我已复制，关闭' }).click();
  await expect(
    page.getByRole('region', { name: '客户门户账号' }),
  ).toContainText(email);
  await expectTemporaryLogin(browser, '/login', email, temporary);
});

test('portal reset and disable', async ({ page, browser }) => {
  const tenant = await createTenant(page);
  const email = `${tenant.code.toLowerCase()}@example.com`;
  const created = await page.request.post(
    `/api/admin/tenants/${tenant.id}/portal-accounts`,
    { data: { email } },
  );
  expect(created.status()).toBe(200);
  await page.goto(`/admin/tenants/${tenant.id}?tab=portal`);
  const section = page.getByRole('region', { name: '客户门户账号' });
  await expect(section).toContainText(email);

  await section.getByRole('button', { name: '重置密码' }).click();
  await page
    .getByRole('dialog', { name: '重置门户账号密码？' })
    .getByRole('button', { name: '重置密码' })
    .click();
  const result = page.getByRole('dialog', { name: '已生成临时密码' });
  const temporary = await result
    .getByRole('textbox', { name: '临时密码', exact: true })
    .inputValue();
  await result.getByRole('button', { name: '我已复制，关闭' }).click();
  await expect(result).toBeHidden();
  await expectTemporaryLogin(browser, '/login', email, temporary);

  await section.getByRole('button', { name: '停用账号' }).click();
  const disable = page.getByRole('dialog', { name: '停用门户账号？' });
  await expect(disable).toContainText('不影响呼叫和计费');
  await disable.getByRole('button', { name: '停用账号' }).click();
  await expect(page.getByRole('status')).toHaveText(
    '门户账号已停用，已记入操作日志',
  );
  await expect(section).toContainText('已停用');
  await expect(
    page.getByRole('note').filter({ hasText: '门户账号已停用' }),
  ).toContainText('呼叫与计费不受影响');

  const context = await browser.newContext({ baseURL: webOrigin });
  const portal = await context.newPage();
  await portal.goto('/login');
  await submitLogin(portal, email, temporary);
  await expect(portal.getByRole('alert')).toContainText('该账号已停用');
  await context.close();
});
