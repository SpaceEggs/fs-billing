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

  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(26);
  const merged = table.getByRole('link', {
    name: /2026-09-28 通话扣费，共 1 通/,
  });
  await expect(merged).toBeVisible();
  const credit = table.getByRole('row').filter({ hasText: '账户充值' });
  await expect(credit).toHaveCount(1);
  await expect(page.getByText('月结，10月5日前付款')).toHaveCount(0);

  await merged.click();
  await expectPath(page, '/portal/cdrs?from=2026-09-28&to=2026-09-28');
  // 话单页确实按这一天取数：日期范围是当天，列表是种子里当天的两通已接通话单。
  await expect(page.getByRole('heading', { name: '话单' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: /日期范围.*2026-09-28 至 2026-09-28/ }),
  ).toBeVisible();
  const calls = page.getByRole('table').getByRole('row');
  await expect(calls).toHaveCount(3);
  await expect(calls.nth(1)).toContainText('2026-09-28 14:10:05');
  await expect(calls.nth(2)).toContainText('2026-09-28 14:03:22');
});

test('filters by type and keeps the range and page in the address', async ({
  page,
}) => {
  await page.goto(septemberPath);
  await page.getByRole('combobox', { name: '类型' }).selectOption('recharge');
  await expectPath(page, `${septemberPath}&kind=recharge`);
  const table = page.getByRole('table');
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(page.getByText('共 2 条 · 合计 +¥2,431.10')).toBeVisible();

  await page.reload();
  await expect(table.getByRole('row')).toHaveCount(3);

  await page.getByRole('combobox', { name: '类型' }).selectOption('gift');
  await expect(page.getByText('共 2 条 · 合计 +¥40.00')).toBeVisible();

  await page.goto(`${septemberPath}&page=2`);
  await expectPath(page, `${septemberPath}&page=2`);
  await expect(page.getByText(/^第 26–/)).toBeVisible();
});

test('shows the empty state of a filtered range', async ({ page }) => {
  await page.goto('/portal/ledger?from=2026-08-01&to=2026-08-31&kind=gift');
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
  expect(text).toContain('银行转账预存');
  expect(text).not.toContain('月结，10月5日前付款');
});
