import { expect, test } from '@playwright/test';
import { accounts } from './accounts';
import { clearLoginFailures, revokeSessions } from './db';
import { expectPath, loginAs, submitLogin } from './helpers';

test('customer login enters the portal and shows the CNY balance', async ({
  page,
}) => {
  await loginAs(page, '/login', accounts.customer);
  await expectPath(page, '/');
  await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();
  await expect(page.getByText('ABC001 · 深圳市某某科技有限公司')).toBeVisible();
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '-¥35.20',
  );
});

test('USD customer balance uses the dollar sign', async ({ page }) => {
  await loginAs(page, '/login', accounts.usdCustomer);
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '-$15.02',
  );
});

test('admin login enters the admin shell', async ({ page }) => {
  await loginAs(page, '/admin/login', accounts.admin);
  await expectPath(page, '/admin');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
  await expect(page.getByRole('button', { name: '账号菜单' })).toContainText(
    '王敏',
  );
  await expect(page.locator('html')).toHaveAttribute('data-product', 'admin');
});

test('the login response kind decides the zone, not the login page used', async ({
  page,
}) => {
  await loginAs(page, '/admin/login', accounts.customer);
  await expectPath(page, '/');
  await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();

  await page.goto('/admin');
  await expectPath(page, '/');

  await page.context().clearCookies();
  await loginAs(page, '/login', accounts.admin);
  await expectPath(page, '/admin');
});

test('an expired cookie redirects to login and returns to the original page', async ({
  page,
}) => {
  await loginAs(page, '/login', accounts.customer);
  await expectPath(page, '/');

  await page.context().clearCookies();
  await page.goto('/?tab=ledger&type=%E5%85%85%E5%80%BC');
  await expectPath(page, '/login');
  await submitLogin(page, accounts.customer);
  await expectPath(page, '/?tab=ledger&type=%E5%85%85%E5%80%BC');
  await expect(page.getByRole('heading', { name: '首页' })).toBeVisible();
});

test('a session revoked in the database prompts re-login and returns to the page', async ({
  page,
}) => {
  await loginAs(page, '/admin/login', accounts.secondAdmin);
  await expectPath(page, '/admin');
  await page.goto('/admin?view=e2e');
  await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();

  await revokeSessions(accounts.secondAdmin);
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });

  const dialog = page.getByRole('dialog', { name: '登录已过期，请重新登录' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('登录后将回到当前页面');
  await dialog.getByRole('button', { name: '重新登录' }).click();

  await expectPath(page, '/admin/login?reason=expired');
  await expect(page.getByRole('status')).toContainText(
    '登录后将返回之前的页面',
  );
  await submitLogin(page, accounts.secondAdmin);
  await expectPath(page, '/admin?view=e2e');
});

test('a return path from the other zone falls back to the identity home', async ({
  page,
}) => {
  await page.goto('/admin?from=portal-user');
  await expectPath(page, '/admin/login');
  await submitLogin(page, accounts.customer);
  await expectPath(page, '/');
});

test('unknown pages show the 404 page and link home', async ({ page }) => {
  await page.goto('/no-such-page');
  await expect(
    page.getByRole('heading', { name: '找不到这个页面' }),
  ).toBeVisible();
  await expect(
    page.getByText('页面不存在或链接已失效，请检查地址是否正确'),
  ).toBeVisible();
  await page.getByRole('link', { name: '返回首页' }).click();
  await expectPath(page, '/login');

  await submitLogin(page, accounts.admin);
  await expectPath(page, '/admin');
  await page.goto('/admin/no-such-page');
  await expect(
    page.getByRole('heading', { name: '找不到这个页面' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '账号菜单' })).toBeVisible();
  await expect(page.getByText('返回首页即回到「概览」')).toBeVisible();
});

test('wrong passwords lock the account and show the retry countdown', async ({
  page,
}) => {
  await clearLoginFailures(accounts.lockTarget);
  try {
    await page.goto('/login');
    const alert = page.getByRole('alert');
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      await submitLogin(page, accounts.lockTarget, `wrong-password-${attempt}`);
      await expect(alert).toBeVisible();
      if ((await alert.textContent())?.includes('已暂时锁定')) break;
      await expect(alert).toContainText('登录邮箱或密码错误');
      await expect(alert).toContainText('请检查后重新输入');
    }
    await expect(alert).toContainText('登录失败次数过多，已暂时锁定');
    await expect(alert).toContainText(/请在 1[45]分\d{2}秒 后重试/);
    const wait = page.getByRole('button', {
      name: /^请在 \d+分\d{2}秒 后重试$/,
    });
    await expect(wait).toBeDisabled();
    await expect(page.getByLabel('登录邮箱')).toBeDisabled();
  } finally {
    await clearLoginFailures(accounts.lockTarget);
  }
});

test('unknown email and wrong password show the same message', async ({
  page,
}) => {
  await page.goto('/login');
  try {
    const unknownResponse = await submitLogin(
      page,
      'nobody-here@example.com',
      'whatever-password',
    );
    const unknown = await page.getByRole('alert').textContent();
    const wrongResponse = await submitLogin(
      page,
      accounts.customer,
      'definitely-wrong-password',
    );
    expect(unknownResponse.status()).toBe(401);
    expect(wrongResponse.status()).toBe(401);
    await expect(page.getByRole('alert')).toHaveText(unknown ?? '');
    await expect(page.getByRole('alert')).toHaveText(
      '登录邮箱或密码错误请检查后重新输入',
    );
  } finally {
    await clearLoginFailures('nobody-here@example.com');
    await clearLoginFailures(accounts.customer);
  }
});

test('a disabled account sees the disabled message', async ({ page }) => {
  await loginAs(page, '/login', accounts.disabledCustomer);
  await expect(page.getByRole('alert')).toContainText('该账号已停用');
  await expect(page.getByRole('alert')).toContainText(
    '如需恢复使用，请联系客服',
  );
});

test('logout from the account menu returns to the login page', async ({
  page,
}) => {
  await loginAs(page, '/login', accounts.customer);
  await page.getByRole('button', { name: '账号菜单' }).click();
  await expect(page.getByRole('menu')).toContainText(
    '深圳市某某科技有限公司 · ABC001',
  );
  await page.getByRole('menuitem', { name: '退出登录' }).click();
  await expectPath(page, '/login');
  await page.goto('/');
  await expectPath(page, '/login');
});

test('theme choice is applied and persisted', async ({ page }) => {
  await loginAs(page, '/admin/login', accounts.admin);
  await page.getByRole('button', { name: '主题' }).click();
  await page.getByRole('menuitemradio', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '主题' }).click();
  await page.getByRole('menuitemradio', { name: '浅色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test.describe('mobile 375px', () => {
  test.use({
    viewport: { width: 375, height: 812 },
    hasTouch: true,
    isMobile: true,
  });

  test('mobile login, account sheet theme switch and logout', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(
      page.getByRole('heading', { name: '登录客户门户' }),
    ).toBeVisible();
    await submitLogin(page, accounts.customer);
    await expectPath(page, '/');
    await page.getByRole('button', { name: '账号菜单' }).click();
    const sheet = page.getByRole('dialog', { name: '账号菜单' });
    await sheet.getByRole('radio', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await sheet.getByRole('radio', { name: '跟随系统' }).click();
    await sheet.getByRole('button', { name: '退出登录' }).click();
    await expectPath(page, '/login');
  });
});
