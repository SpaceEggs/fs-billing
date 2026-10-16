import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { createTenant, openTenants, test, uniqueCode } from './admin';

/** 通过后台接口赊账充值，形成一笔全额待收款，返回原 credit 流水 id。 */
async function creditTopup(
  page: Page,
  tenant: { id: string },
  currency: 'CNY' | 'USD',
  amount: string,
) {
  const response = await page.request.post(
    `/api/admin/tenants/${tenant.id}/balance-operations`,
    {
      data: {
        kind: 'credit_topup',
        currency,
        amount,
        internalNote: '端到端赊账',
        idempotencyKey: randomUUID(),
      },
    },
  );
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { entry: { id: string } };
  return body.entry.id;
}

/** 本次运行专用的租户编码前缀，搜索它即可只看到本用例种下的应收。 */
async function seedTenant(page: Page, currency: 'CNY' | 'USD', run: string) {
  return createTenant(page, { currency, code: `${run}${currency}` });
}

function beijingToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function openReceivables(page: Page, run: string) {
  await page.goto(`/admin/receivables?search=${run}`);
  await expect(page.getByRole('heading', { name: '待收款' })).toBeVisible();
  return page.getByRole('table');
}

test('renders CNY and USD totals separately', async ({ page }) => {
  await openTenants(page);
  const run = uniqueCode('RCV');
  const cny = await seedTenant(page, 'CNY', run);
  const usd = await seedTenant(page, 'USD', run);
  await creditTopup(page, cny, 'CNY', '1234.56');
  await creditTopup(page, cny, 'CNY', '100.00');
  await creditTopup(page, usd, 'USD', '78.90');

  const table = await openReceivables(page, run);
  const totals = page.getByRole('list', { name: '待收款合计' });
  await expect(totals.getByRole('listitem')).toHaveText([
    '待收款总额 · CNY¥1,334.56',
    '待收款总额 · USD$78.90',
  ]);
  // 不出现跨币种相加的数字。
  await expect(totals).not.toContainText('1,413.46');
  await expect(table.getByRole('row')).toHaveCount(4);

  await page.getByRole('group', { name: '币种' }).getByText('USD').click();
  await expect(totals.getByRole('listitem')).toHaveText([
    '待收款总额 · USD$78.90',
  ]);
  await expect(totals).not.toContainText('CNY');
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText(usd.code);
  await expect(table).not.toContainText(cny.code);
});

test('confirms full payment without changing balance', async ({ page }) => {
  await openTenants(page);
  const run = uniqueCode('RCV');
  const tenant = await seedTenant(page, 'CNY', run);
  await creditTopup(page, tenant, 'CNY', '2000');

  const table = await openReceivables(page, run);
  await table
    .getByRole('button', { name: `确认收款 ${tenant.code} ¥2,000.00` })
    .click();
  const dialog = page.getByRole('dialog', { name: '确认收款' });
  await expect(dialog).toContainText('客户余额不变');
  await expect(dialog.getByLabel(/实际收款日期/)).toHaveValue(beijingToday());
  await dialog.getByLabel(/收款备注/).fill('工行对公转账');
  await dialog.getByRole('button', { name: '确认收款 ¥2,000.00' }).click();

  await expect(page.getByRole('status')).toContainText(
    `${tenant.code} ¥2,000.00 已确认收款，状态变为「已收款」`,
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('没有符合条件的待收款')).toBeVisible();

  const detail = await page.request.get(`/api/admin/tenants/${tenant.id}`);
  const body = (await detail.json()) as { balance: string };
  expect(body.balance).toMatch(/^2000(\.0+)?$/);
});

test('refreshes after settlement conflict and reconfirms with fresh token', async ({
  page,
}) => {
  await openTenants(page);
  const run = uniqueCode('RCV');
  const tenant = await seedTenant(page, 'CNY', run);
  const ledgerEntryId = await creditTopup(page, tenant, 'CNY', '500');

  // 页面拿到 latestSettlementId = null 后，另一位管理员确认又撤销：页面上的令牌已过时。
  const table = await openReceivables(page, run);
  const button = table.getByRole('button', {
    name: `确认收款 ${tenant.code} ¥500.00`,
  });
  await expect(button).toBeVisible();
  const confirmed = await page.request.post(
    `/api/admin/receivables/${ledgerEntryId}/confirm-payment`,
    {
      data: { expectedLatestSettlementId: null, receivedOn: beijingToday() },
    },
  );
  expect(confirmed.status()).toBe(200);
  const { settlementId } = (await confirmed.json()) as {
    settlementId: string;
  };
  const reversed = await page.request.post(
    `/api/admin/receivables/${ledgerEntryId}/reverse-payment`,
    { data: { settlementId, reason: '误确认' } },
  );
  expect(reversed.status()).toBe(200);

  const posts: unknown[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/confirm-payment')
    )
      posts.push(request.postDataJSON());
  });
  await button.click();
  let dialog = page.getByRole('dialog', { name: '确认收款' });
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/admin/receivables' &&
      response.request().method() === 'GET',
  );
  await dialog.getByRole('button', { name: '确认收款 ¥500.00' }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('未确认收款');
  await expect(alert).toContainText('请核对后重新确认');
  await refreshed;
  await expect(alert).toContainText('列表已刷新。');
  await expect(
    dialog.getByRole('button', { name: '确认收款 ¥500.00' }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
  expect(posts).toHaveLength(1);

  // 刷新后的行仍待收款，重新打开使用新令牌。
  await button.click();
  dialog = page.getByRole('dialog', { name: '确认收款' });
  await dialog.getByRole('button', { name: '确认收款 ¥500.00' }).click();
  await expect(page.getByRole('status')).toContainText(
    `${tenant.code} ¥500.00 已确认收款`,
  );
  expect(posts).toEqual([
    expect.objectContaining({ expectedLatestSettlementId: null }),
    expect.objectContaining({ expectedLatestSettlementId: settlementId }),
  ]);
});
