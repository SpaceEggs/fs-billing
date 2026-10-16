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

async function balance(page: Page, tenant: { id: string }) {
  const response = await page.request.get(`/api/admin/tenants/${tenant.id}`);
  return ((await response.json()) as { balance: string }).balance;
}

async function adminName(page: Page) {
  const response = await page.request.get('/api/auth/session');
  return ((await response.json()) as { identity: { name: string } }).identity
    .name;
}

test('refreshes after settlement conflict', async ({ page }) => {
  await openTenants(page);
  const run = uniqueCode('RCV');
  const tenant = await seedTenant(page, 'CNY', run);
  const ledgerEntryId = await creditTopup(page, tenant, 'CNY', '500');

  const posts: unknown[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/confirm-payment')
    )
      posts.push(request.postDataJSON());
  });
  const table = await openReceivables(page, run);
  const button = table.getByRole('button', {
    name: `确认收款 ${tenant.code} ¥500.00`,
  });
  await button.click();
  let dialog = page.getByRole('dialog', { name: '确认收款' });
  await expect(dialog).toBeVisible();

  // 对话框打开期间，另一位管理员确认又撤销：对话框里的令牌已过时。
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

test('reverses then reconfirms with fresh token', async ({ page }) => {
  await openTenants(page);
  const run = uniqueCode('RCV');
  const tenant = await seedTenant(page, 'CNY', run);
  await creditTopup(page, tenant, 'CNY', '800');
  const name = await adminName(page);
  const posts: { url: string; body: unknown }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/receivables/'))
      posts.push({ url: request.url(), body: request.postDataJSON() });
  });

  const table = await openReceivables(page, run);
  await table
    .getByRole('button', { name: `确认收款 ${tenant.code} ¥800.00` })
    .click();
  let dialog = page.getByRole('dialog', { name: '确认收款' });
  await dialog.getByLabel(/收款备注/).fill('工行对公转账');
  await dialog.getByRole('button', { name: '确认收款 ¥800.00' }).click();
  await expect(page.getByRole('status')).toContainText('已确认收款');
  const firstSettlement = (
    (await (
      await page.request.get(
        `/api/admin/receivables?status=received&search=${run}`,
      )
    ).json()) as { items: { payment: { settlementId: string } }[] }
  ).items[0]!.payment.settlementId;

  const status = page.getByRole('group', { name: '状态' });
  await status.getByRole('button', { name: '已收款' }).click();
  await expect(page).toHaveURL(/status=received/);
  const row = table.getByRole('row').filter({ hasText: tenant.code });
  await expect(row).toContainText('工行对公转账');
  await expect(row).toContainText(name);
  await row
    .getByRole('button', { name: `撤销确认 ${tenant.code} ¥800.00` })
    .click();
  dialog = page.getByRole('dialog', { name: '撤销确认' });
  await expect(dialog).toContainText(`确认人${name}`);
  await dialog.getByLabel(/撤销原因/).fill('款项未实际到账');
  await dialog.getByRole('button', { name: '撤销确认' }).click();
  await expect(page.getByRole('status')).toContainText(
    `${tenant.code} ¥800.00 已撤销确认，回到「待收款」`,
  );
  await expect(page.getByText('没有符合条件的已收款')).toBeVisible();

  await status.getByRole('button', { name: '待收款' }).click();
  await table
    .getByRole('button', { name: `确认收款 ${tenant.code} ¥800.00` })
    .click();
  dialog = page.getByRole('dialog', { name: '确认收款' });
  await dialog.getByRole('button', { name: '确认收款 ¥800.00' }).click();
  await expect(page.getByRole('status')).toContainText(
    `${tenant.code} ¥800.00 已确认收款`,
  );
  expect(posts.map((post) => post.body)).toEqual([
    expect.objectContaining({ expectedLatestSettlementId: null }),
    { settlementId: firstSettlement, reason: '款项未实际到账' },
    expect.objectContaining({ expectedLatestSettlementId: firstSettlement }),
  ]);
});

test('voids with linked adjustment', async ({ page }) => {
  await openTenants(page);
  const run = uniqueCode('RCV');
  const tenant = await seedTenant(page, 'CNY', run);
  await creditTopup(page, tenant, 'CNY', '500.00');
  const name = await adminName(page);

  const table = await openReceivables(page, run);
  await table
    .getByRole('button', { name: `作废 ${tenant.code} ¥500.00` })
    .click();
  let dialog = page.getByRole('dialog', { name: '作废应收' });
  await expect(dialog).toContainText('没有可用的冲正调账');
  await expect(dialog).toContainText('调账不会自动关闭应收');

  // 经真实的余额操作对话框做一笔相反金额的调账（预填 -500.00）。
  await dialog.getByRole('button', { name: '去调账 -¥500.00' }).click();
  const adjust = page.getByRole('dialog', { name: '余额操作' });
  await expect(adjust.getByRole('radio', { name: '调账' })).toBeChecked();
  await expect(adjust.getByLabel(/金额/)).toHaveValue(/^-500(\.0+)?$/);
  await adjust.getByRole('button', { name: '下一步' }).click();
  await adjust.getByRole('button', { name: '确认调账' }).click();
  await expect(adjust.getByRole('status')).toContainText('已入账');
  await adjust.getByRole('button', { name: '完成' }).click();
  const afterAdjustment = await balance(page, tenant);
  expect(afterAdjustment).toMatch(/^0(\.0+)?$/);

  dialog = page.getByRole('dialog', { name: '作废应收' });
  const candidates = dialog.getByRole('radiogroup', { name: /冲正调账/ });
  await expect(candidates.getByRole('radio')).toHaveCount(1);
  await candidates.getByRole('radio').check();
  await dialog.getByLabel(/作废原因/).fill('客户合同终止');
  await dialog.getByRole('button', { name: '作废 ¥500.00' }).click();
  await expect(page.getByRole('status')).toContainText(
    `${tenant.code} ¥500.00 已作废，状态变为「已作废」`,
  );
  expect(await balance(page, tenant)).toBe(afterAdjustment);

  await page
    .getByRole('group', { name: '状态' })
    .getByRole('button', { name: '已作废' })
    .click();
  const row = table.getByRole('row').filter({ hasText: tenant.code });
  await expect(row).toContainText('客户合同终止');
  await expect(row).toContainText(name);
  await expect(row.getByRole('button')).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: '已作废合计' }).getByRole('listitem'),
  ).toHaveText(['已作废总额 · CNY¥500.00', '已作废总额 · USD$0.00']);
});
