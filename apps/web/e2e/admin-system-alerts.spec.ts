import { expect } from '@playwright/test';
import { test } from './admin';
import { createSystemAlert, removeSystemAlert } from './db';

test('overview and system alerts settings', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByText('含已停用')).toBeVisible();
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
  const chart = page.getByRole('list', { name: '最近 30 天每日消费' });
  await chart.focus();
  await chart.press('Home');
  await expect(page.getByTestId('chart-bubble')).toBeVisible();
  await page.getByRole('button', { name: 'USD', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'USD', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: /系统告警/ })
    .click();
  await expect(page.getByRole('tab', { name: '告警列表' })).toBeVisible();
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(
    page.getByText('未设置接收邮箱，当前发给全部管理员'),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('设置未更改')).toBeVisible();
});

test('shows an open alert and its detail', async ({ page }) => {
  const id = await createSystemAlert();
  try {
    await page.goto('/admin/system-alerts');
    await expect(page.getByLabel('有进行中的告警')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: '端到端授权超时' });
    await row.getByRole('button').click();
    await expect(page.getByText('影响的通话', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无通知记录')).toBeVisible();
  } finally {
    await removeSystemAlert(id);
  }
});

test('opens alert details in a phone bottom sheet', async ({ page }) => {
  const id = await createSystemAlert();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/system-alerts');
    await page.getByRole('button', { name: /端到端授权超时/ }).click();
    const sheet = page.getByRole('dialog', { name: '告警详情' });
    await expect(sheet.getByText('影响的通话', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  } finally {
    await removeSystemAlert(id);
  }
});
