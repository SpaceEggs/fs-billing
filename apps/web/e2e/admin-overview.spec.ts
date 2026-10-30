import { expect } from '@playwright/test';
import { test } from './admin';
import { expectPath } from './helpers';

/** 取一段金额文字里 `¥` 与 `$` 开头的两个数。 */
function amounts(text: string) {
  return {
    CNY: /¥[\d,]+\.\d{2}/.exec(text)?.[0],
    USD: /\$[\d,]+\.\d{2}/.exec(text)?.[0],
  };
}

test('shows the same receivable totals and alert count as their pages', async ({
  page,
}) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
  await expect(page.getByText('CNY 租户', { exact: true })).toBeVisible();
  await expect(page.getByText('USD 租户', { exact: true })).toBeVisible();

  // 待收款总额卡片（CNY 与 USD 分行，不相加）。
  const card = page
    .locator('section')
    .filter({ has: page.getByText('待收款总额', { exact: true }) });
  await expect(card).toContainText('CNY');
  const overview = amounts(await card.innerText());
  expect(overview.CNY).toBeDefined();
  expect(overview.USD).toBeDefined();

  // 系统告警：最近 24 小时的条数，链接落在同一口径的列表上。
  const alertLink = page.getByRole('link', {
    name: /^系统告警\s*最近 24 小时 · \d+ 条/,
  });
  await expect(alertLink).toBeVisible();
  const count = Number(/(\d+) 条/.exec(await alertLink.innerText())?.[1]);
  expect(count).toBeGreaterThan(0);

  // 待收款页的合计（默认「待收款」状态）。
  await page.goto('/admin/receivables');
  const totals = page.getByRole('list', { name: '待收款合计' });
  await expect(totals.getByRole('listitem')).toHaveCount(2);
  await expect(totals.getByRole('listitem').first()).not.toContainText(
    '加载中',
  );
  const receivables = amounts(await totals.innerText());
  expect(receivables).toEqual(overview);

  // 从概览点进告警页：地址带窗口，时间选择停在「最近 24 小时」，「共 N 条」与概览一致。
  await page.goto('/admin');
  await page
    .getByRole('link', { name: /^系统告警\s*最近 24 小时 · \d+ 条/ })
    .click();
  await expectPath(page, '/admin/system-alerts?window=24h');
  await expect(page.getByRole('combobox', { name: '时间' })).toHaveValue('24h');
  await expect(page.getByText(`共 ${count} 条`, { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: '系统告警' })).toBeVisible();
});

test('each alert row on the overview opens the 24 hour list', async ({
  page,
}) => {
  await page.goto('/admin');
  const rows = page
    .locator('a[href*="/admin/system-alerts"]:visible')
    .filter({ hasText: /授权超时|话单处理失败|邮件发送失败/ });
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  await expectPath(page, '/admin/system-alerts?window=24h');
  await expect(page.getByRole('tab', { name: '告警列表' })).toBeVisible();
});

test('lists suspended and low balance tenants in the attention area', async ({
  page,
}) => {
  await page.goto('/admin');
  await expect(page.getByText('已停机租户').first()).toBeVisible();
  await expect(page.getByText('余额不足租户')).toBeVisible();
  // 已停机租户的行跳到租户详情。
  const suspended = page.getByRole('link', { name: /HZX014/ }).first();
  await expect(suspended).toBeVisible();
  await suspended.click();
  await expect(page).toHaveURL(/\/admin\/tenants\//);
});

test('the daily spend chart is driven by the keyboard and switches currency', async ({
  page,
}) => {
  await page.goto('/admin');
  const chart = page.getByRole('list', { name: '最近 30 天每日消费' });
  const bubble = page.getByTestId('chart-bubble');
  await expect(bubble).toHaveCount(0);

  // 聚焦即显示最后一根（今日）；用键盘逐根查看，不依赖鼠标悬停与具体日期。
  await chart.focus();
  await expect(bubble).toContainText('（今日）');
  await chart.press('ArrowLeft');
  await expect(bubble).not.toContainText('（今日）');
  await expect(bubble).toContainText(/\d{4}-\d{2}-\d{2}/);
  await chart.press('Home');
  await expect(bubble).toContainText('¥');
  await chart.press('End');
  await expect(bubble).toContainText('（今日）');
  await chart.press('Escape');
  await expect(bubble).toHaveCount(0);

  await page.getByRole('button', { name: 'USD', exact: true }).click();
  await expect(page.getByText('所有 USD 租户合计')).toBeVisible();
  await chart.focus();
  await chart.press('Home');
  await expect(bubble).toContainText('$');
  await expect(bubble).not.toContainText('¥');
});

test('shows the phone attention cards and tenant balance context', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: /HZX014/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /未归属话单.*未计费/ }),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: /余额不足.*个/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /系统告警.*授权超时/ }),
  ).toBeVisible();
});
