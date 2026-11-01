import { expect } from '@playwright/test';
import { test } from './admin';

function seconds(value: string) {
  const first = value.split(',')[0]?.trim() ?? value;
  if (first.endsWith('ms')) return parseFloat(first) / 1000;
  return parseFloat(first);
}

test('dialog motion uses tokens and reduced motion is instant', async ({
  page,
}) => {
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();

  const token = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--motion-base')
      .trim(),
  );
  expect(seconds(token)).toBeCloseTo(0.18, 2);

  await page.getByRole('button', { name: '＋ 新增管理员' }).click();
  const dialog = page.getByRole('dialog', { name: '新增管理员' });
  await expect(dialog).toBeVisible();

  const moving = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(moving.name).not.toBe('none');
  expect(seconds(moving.duration)).toBeGreaterThan(0.1);
  expect(seconds(moving.duration)).toBeLessThanOrEqual(0.22);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  const reducedToken = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--motion-base')
      .trim(),
  );
  expect(seconds(reducedToken)).toBe(0);

  const reduced = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(reduced.name).toBe('none');
});
