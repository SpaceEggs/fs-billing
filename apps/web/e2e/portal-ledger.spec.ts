import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { accounts } from './accounts';
import { expectPath, loginAs } from './helpers';

const septemberPath = '/portal/ledger?from=2026-09-01&to=2026-09-30';

test.beforeEach(async ({ page }) => {
  await loginAs(page, '/login', accounts.customer);
  await expectPath(page, '/');
});

test('merges daily charges and jumps to that day of CDRs', async ({ page }) => {
  await page.goto(septemberPath);
  await expect(page.getByRole('heading', { name: '余额流水' })).toBeVisible();
  await expect(page.getByText('当前余额').first()).toBeVisible();

  // 阶段 7 PR 1 起种子是月账单设计稿：9 月 1 至 29 日每天一组合并的通话扣费，加 3 笔人工流水，共 32 行，每页 25 行。
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(26);
  const merged = table.getByRole('link', {
    name: /2026-09-28 通话扣费，共 454 通/,
  });
  await expect(merged).toBeVisible();
  const credit = table.getByRole('row').filter({ hasText: '账户充值' });
  await expect(credit).toHaveCount(1);
  await expect(page.getByText('月结，10月5日前付款')).toHaveCount(0);

  await merged.click();
  await expectPath(page, '/portal/cdrs?from=2026-09-28&to=2026-09-28');
  // 话单页确实按这一天取数：日期范围是当天，默认只看已接通：454 通、1,776 分钟、¥88.64（设计稿 9 月 28 日），另有 1 通未接通的示例话单，每页 50 行。
  await expect(page.getByRole('heading', { name: '话单' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /日期范围.*2026-09-28 至 2026-09-28/ }),
  ).toBeVisible();
  const summary = page.getByRole('region', { name: '汇总' });
  await expect(summary).toContainText('通话数454');
  await expect(summary).toContainText('另有未接通 1 通');
  await expect(summary).toContainText('总计费1,776分钟');
  await expect(summary).toContainText('总费用¥88.64');
  await expect(page.getByRole('table').getByRole('row')).toHaveCount(51);
});

test('filters by type and keeps the range and page in the address', async ({
  page,
}) => {
  await page.goto(septemberPath);
  await page.getByRole('combobox', { name: '类型' }).selectOption('recharge');
  await expectPath(page, `${septemberPath}&kind=recharge`);
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(page.getByText('共 2 条 · 合计 +¥1,300.00')).toBeVisible();

  await page.reload();
  await expect(table.getByRole('row')).toHaveCount(3);

  // 9 月没有赠送（月账单设计稿：赠送 0.00）。
  await page.getByRole('combobox', { name: '类型' }).selectOption('gift');
  await expect(page.getByText('没有符合条件的流水')).toBeVisible();

  await page.goto('/portal/ledger?from=2026-08-01&to=2026-08-31&kind=gift');
  await expect(page.getByText('共 1 条 · 合计 +¥50.00')).toBeVisible();

  await page.goto(`${septemberPath}&page=2`);
  await expectPath(page, `${septemberPath}&page=2`);
  await expect(page.getByText('第 26–32 条，共 32 条')).toBeVisible();
});

test('shows the empty state of a filtered range', async ({ page }) => {
  // ABC001 8 月 12 日开户，7 月没有任何流水。
  await page.goto('/portal/ledger?from=2026-07-01&to=2026-07-31&kind=gift');
  await expect(page.getByText('没有符合条件的流水')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page).not.toHaveURL(/kind=/);
});

test('exports the filtered ledger as a CSV with the customer view of a credit recharge', async ({
  page,
}) => {
  await page.goto(`${septemberPath}&kind=recharge`);
  await expect(page.getByText('第 1–2 条，共 2 条')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(
    'ledger_ABC001_2026-09-01_2026-09-30.csv',
  );
  const text = await readFile((await file.path()) ?? '', 'utf8');
  expect(text.charCodeAt(0)).toBe(0xfeff);
  expect(text).toContain('账户充值');
  expect(text).toContain('银行转账 · 招行尾号 6621');
  expect(text).not.toContain('月结，10月5日前付款');
});
