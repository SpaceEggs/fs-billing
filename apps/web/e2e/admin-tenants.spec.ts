import { expect } from '@playwright/test';
import { createTenant, openTenants, test, uniqueCode } from './admin';
import { expectPath, submitCredentials } from './helpers';

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

  const customer = await browser.newPage({
    storageState: { cookies: [], origins: [] },
  });
  await customer.goto('/login');
  await customer.getByLabel('登录邮箱').fill(portalEmail);
  await customer.getByLabel('密码', { exact: true }).fill(temporaryPassword);
  const login = await submitCredentials(customer, '/api/auth/login', () =>
    customer.getByRole('button', { name: '登录', exact: true }).click(),
  );
  expect(login.status()).toBe(200);
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
  const changed = await submitCredentials(
    customer,
    '/api/auth/change-password',
    () => customer.getByRole('button', { name: '修改密码' }).click(),
  );
  expect(changed.status()).toBe(200);
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

test('disable confirmation explains live call behavior', async ({ page }) => {
  await openTenants(page);
  const tenant = await createTenant(page);
  await page.goto(`/admin/tenants/${tenant.id}`);
  await page.getByRole('button', { name: '停用', exact: true }).click();

  const dialog = page.getByRole('dialog', {
    name: `停用租户 ${tenant.code}？`,
  });
  await expect(dialog).toContainText('停用不能保证立即停止呼叫');
  await expect(dialog).toContainText('新呼叫仍可能按最多 1800 秒放行');
  await expect(dialog).toContainText('已接通电话按原上限结束并正常计费');
  await dialog.getByRole('button', { name: '停用租户' }).click();

  await expect(page.getByText('租户已停用，已记入操作日志')).toBeVisible();
  await expect(
    page.getByRole('button', { name: '启用', exact: true }),
  ).toBeVisible();
});
