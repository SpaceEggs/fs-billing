import { expect, test } from '@playwright/test';

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
