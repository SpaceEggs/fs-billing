import { expect, type Locator } from '@playwright/test';
import { test } from './admin';

function seconds(value: string) {
  const first = value.split(',')[0]?.trim() ?? value;
  if (first.endsWith('ms')) return parseFloat(first) / 1000;
  return parseFloat(first);
}

async function animationOf(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
}

test('dialog motion uses tokens and reduced motion is instant', async ({
  page,
}) => {
  const nav = page.getByRole('navigation', { name: '主导航' });
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();

  const tokens = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      base: root.getPropertyValue('--motion-base').trim(),
      fast: root.getPropertyValue('--motion-fast').trim(),
    };
  });
  expect(seconds(tokens.base)).toBeCloseTo(0.18, 2);
  expect(seconds(tokens.fast)).toBeCloseTo(0.12, 2);

  const main = page.locator('main');
  expect((await animationOf(main)).name).toBe('none');
  const row = page.locator('[data-slot="table-body"] tr').first();
  await expect(row).toBeVisible();
  expect((await animationOf(row)).name).toBe('none');

  await nav.getByRole('link', { name: '租户' }).click();
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  const route = await animationOf(main);
  expect(route.name).not.toBe('none');
  expect(seconds(route.duration)).toBeCloseTo(seconds(tokens.base), 2);

  await nav.getByRole('link', { name: '管理员' }).click();
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();
  await page.getByRole('button', { name: '＋ 新增管理员' }).click();
  const dialog = page.getByRole('dialog', { name: '新增管理员' });
  await expect(dialog).toBeVisible();

  const enter = await animationOf(dialog);
  expect(enter.name).not.toBe('none');
  expect(seconds(enter.duration)).toBeCloseTo(seconds(tokens.base), 2);

  const exit = await dialog.evaluate((element) => {
    element.setAttribute('data-state', 'closed');
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(exit.name).not.toBe('none');
  expect(seconds(exit.duration)).toBeCloseTo(seconds(tokens.fast), 2);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();
  await nav.getByRole('link', { name: '租户' }).click();
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  expect((await animationOf(main)).name).toBe('none');

  await nav.getByRole('link', { name: '管理员' }).click();
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();
  const refresh = page.locator('.motion-refresh').first();
  await expect(refresh).toBeVisible();
  expect(
    await refresh.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe('0s');

  await page.getByRole('button', { name: '＋ 新增管理员' }).click();
  const reducedDialog = page.getByRole('dialog', { name: '新增管理员' });
  await expect(reducedDialog).toBeVisible();
  expect((await animationOf(reducedDialog)).name).toBe('none');
});
