import { expect, test, type Page } from '@playwright/test';
import { accounts } from './accounts';
import { expectPath, loginAs } from './helpers';

/** 每次运行用新编码，避免与种子数据或上次运行冲突。 */
function uniqueCode() {
  return `E2E${Date.now().toString(36).toUpperCase()}`;
}

async function openTenants(page: Page) {
  await loginAs(page, '/admin/login', accounts.admin);
  await expectPath(page, '/admin');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '租户' })
    .click();
  await expectPath(page, '/admin/tenants');
}

test('tenant list shows seeded tenants with status and per-currency balances', async ({
  page,
}) => {
  await openTenants(page);
  const abc = page.getByRole('row').filter({ hasText: 'ABC001' });
  await expect(abc).toContainText('透支中');
  await expect(abc).toContainText('-¥35.20');
  const glb = page.getByRole('row').filter({ hasText: 'GLB009' });
  await expect(glb).toContainText('已停机');
  await expect(glb).toContainText('-$15.02');

  await page.getByRole('button', { name: 'USD' }).click();
  await expectPath(page, '/admin/tenants?currency=USD');
  await expect(page.getByRole('row').filter({ hasText: 'ABC001' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('row').filter({ hasText: 'GLB009' })).toHaveCount(
    1,
  );
});

test('onboarding shows the generated portal password once and the new account must change it', async ({
  page,
  browser,
}) => {
  const code = uniqueCode();
  const portalEmail = `${code.toLowerCase()}@example.com`;
  await openTenants(page);
  await page.getByRole('link', { name: '＋ 新建租户' }).first().click();
  await expectPath(page, '/admin/tenants/new');

  await page.getByLabel(/租户编码/).fill(code.toLowerCase());
  await expect(page.getByText(`将保存为大写 ${code}`)).toBeVisible();
  await page.getByLabel(/租户名称/).fill('端到端测试租户');
  await page.getByLabel(/余额提醒阈值/).fill('200');
  await page.getByLabel(/登录邮箱/).fill(portalEmail);
  await page.getByRole('button', { name: '创建租户' }).click();

  const dialog = page.getByRole('dialog', { name: `租户 ${code} 已创建` });
  await expect(
    dialog.getByRole('textbox', { name: 'FreeSWITCH 通道变量', exact: true }),
  ).toHaveValue(`billing_tenant=${code}`);
  const temporary = dialog.getByRole('textbox', {
    name: '临时密码',
    exact: true,
  });
  await expect(temporary).toBeVisible();
  const temporaryPassword = await temporary.inputValue();
  expect(temporaryPassword.length).toBeGreaterThanOrEqual(8);

  await dialog.getByRole('button', { name: '查看租户' }).click();
  await expect(temporary).toHaveCount(0);
  await expect(page.getByText(temporaryPassword)).toHaveCount(0);
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '¥0.00',
  );

  const customer = await browser.newPage();
  await customer.goto('/login');
  await customer.getByLabel('登录邮箱').fill(portalEmail);
  await customer.getByLabel('密码', { exact: true }).fill(temporaryPassword);
  await customer.getByRole('button', { name: '登录', exact: true }).click();
  await expectPath(customer, '/change-password');
  await expect(
    customer.getByRole('heading', { name: '请修改初始密码' }),
  ).toBeVisible();

  const newPassword = `New-${temporaryPassword}`;
  await customer
    .getByLabel('当前密码', { exact: true })
    .fill(temporaryPassword);
  await customer.getByLabel('新密码', { exact: true }).fill(newPassword);
  await customer.getByLabel('确认新密码', { exact: true }).fill(newPassword);
  await customer.getByRole('button', { name: '修改密码' }).click();
  await expectPath(customer, '/');
  await expect(customer.getByRole('heading', { name: '首页' })).toBeVisible();
  await customer.close();
});

test('a duplicate tenant code is reported on the code field', async ({
  page,
}) => {
  await openTenants(page);
  await page.goto('/admin/tenants/new');
  await page.getByLabel(/租户编码/).fill('abc001');
  await page.getByLabel(/租户名称/).fill('重复编码');
  await page.getByLabel(/余额提醒阈值/).fill('200');
  await page.getByLabel(/登录邮箱/).fill('duplicate-code@example.com');
  await page.getByRole('button', { name: '创建租户' }).click();
  await expect(page.getByText('租户编码已被使用')).toBeVisible();
  await expect(page.getByText('编码 ABC001 已存在，请换一个')).toBeVisible();
});
