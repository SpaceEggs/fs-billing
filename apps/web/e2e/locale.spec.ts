import { expect, test } from '@playwright/test';
import { accounts } from './accounts';
import { expectPath, loginAs } from './helpers';

test.describe('browser language ja-JP', () => {
  test.use({ locale: 'ja-JP' });

  test('falls back to English on the login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

test.describe('browser language zh-CN', () => {
  test.use({ locale: 'zh-CN' });

  test('switches to English and keeps it after reload', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');

    await page.getByRole('button', { name: '语言' }).click();
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });
});

// 其他 e2e 共用种子账号：无论断言是否失败，最后都把账号语言恢复成中文。
test('the account language follows the account into a fresh context', async ({
  page,
  browser,
}) => {
  await loginAs(page, '/login', accounts.customer);
  await expectPath(page, '/');
  try {
    await page.getByRole('button', { name: '语言' }).click();
    const saved = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === '/api/auth/locale' &&
        candidate.request().method() === 'POST',
    );
    await page.getByRole('menuitemradio', { name: 'English' }).click();
    expect((await saved).status()).toBe(204);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    // 全新上下文没有 localStorage，登录后只以账号语言为准。
    const context = await browser.newContext({ locale: 'zh-CN' });
    try {
      const fresh = await context.newPage();
      await loginAs(fresh, '/login', accounts.customer);
      await expectPath(fresh, '/');
      await expect(fresh.locator('html')).toHaveAttribute('lang', 'en');
    } finally {
      await context.close();
    }
  } finally {
    const restored = await page.request.post('/api/auth/locale', {
      data: { locale: 'zh' },
    });
    expect(restored.status()).toBe(204);
  }
});
