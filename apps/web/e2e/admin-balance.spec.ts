import { expect } from '@playwright/test';
import {
  createTenant,
  disableTenant,
  fillBalance,
  openTenants,
  test,
} from './admin';

test('blocks blank adjustment reason', async ({ page }) => {
  await openTenants(page);
  const tenant = await createTenant(page);
  await page.goto(`/admin/tenants/${tenant.id}`);
  let posted = false;
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      request.url().endsWith('/balance-operations')
    )
      posted = true;
  });

  const dialog = await fillBalance(page, '调账', '-12.5', '   ');
  await expect(dialog.getByText('调账必须填写备注')).toBeVisible();
  await expect(dialog.getByLabel(/备注/)).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(dialog.getByRole('button', { name: '确认调账' })).toHaveCount(0);
  expect(posted).toBe(false);

  await dialog.getByLabel(/备注/).fill('话单重复扣费冲正');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await dialog.getByRole('button', { name: '确认调账' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    '调账 -¥12.50 已入账，当前余额 -¥12.50',
  );
  expect(posted).toBe(true);
});

test('disabled tenant confirmation explains unchanged status', async ({
  page,
}) => {
  await openTenants(page);
  const tenant = await createTenant(page);
  await disableTenant(page, tenant.id);
  await page.goto(`/admin/tenants/${tenant.id}`);
  await expect(
    page.getByRole('button', { name: '启用', exact: true }),
  ).toBeVisible();

  const dialog = await fillBalance(page, '充值', '300', '银行转账');
  const note = dialog.getByRole('note');
  await expect(note).toContainText('该租户已停用，状态不会改变');
  await expect(note).toContainText('不会自动启用');
  await expect(dialog).toContainText('，状态保持「已停用」');
  await dialog.getByRole('button', { name: '确认充值' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    '充值 +¥300.00 已入账，当前余额 ¥300.00',
  );
  await dialog.getByRole('button', { name: '完成' }).click();

  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '¥300.00',
  );
  await expect(page.getByText('已停用').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: '启用', exact: true }),
  ).toBeVisible();
});

test('gift and credit require second confirmation only above configured currency threshold', async ({
  page,
}) => {
  await openTenants(page);
  const cny = await createTenant(page);
  await page.goto(`/admin/tenants/${cny.id}`);

  // 默认阈值 CNY 10000：恰等于阈值不需要二次确认。
  let dialog = await fillBalance(page, '赠送', '10000.00');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '确认赠送' })).toBeEnabled();
  await dialog.getByRole('button', { name: '返回修改' }).click();

  await dialog.getByLabel('金额').fill('10000.01');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await expect(dialog).toContainText('大额赠送，需要二次确认');
  await expect(dialog).toContainText('金额超过 CNY 大额阈值 ¥10,000.00');
  const confirm = dialog.getByRole('button', { name: '确认赠送' });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /我已核对/ }).check();
  await expect(confirm).toBeEnabled();
  await dialog.getByRole('button', { name: '返回修改' }).click();

  await dialog.getByRole('radio', { name: '赊账充值', exact: true }).check();
  await dialog.getByRole('button', { name: '下一步' }).click();
  await expect(dialog).toContainText('大额赊账充值，需要二次确认');
  await dialog.getByRole('checkbox', { name: /我已核对/ }).check();
  await dialog.getByRole('button', { name: '确认赊账充值' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    '赊账充值 +¥10,000.01 已入账',
  );
  await dialog.getByRole('button', { name: '完成' }).click();

  // 充值、调账不适用大额确认。
  dialog = await fillBalance(page, '充值', '50000');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '返回修改' }).click();
  await dialog.getByRole('button', { name: '取消' }).click();

  // USD 阈值 1500，与 CNY 分开。
  const usd = await createTenant(page, { currency: 'USD' });
  await page.goto(`/admin/tenants/${usd.id}`);
  dialog = await fillBalance(page, '赠送', '1500');
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: '返回修改' }).click();
  await dialog.getByLabel('金额').fill('1500.01');
  await dialog.getByRole('button', { name: '下一步' }).click();
  await expect(dialog).toContainText('金额超过 USD 大额阈值 $1,500.00');
  await expect(dialog.getByRole('button', { name: '确认赠送' })).toBeDisabled();
});

test('ledger range defaults to this Beijing month and filters by a picked range', async ({
  page,
}) => {
  await openTenants(page);
  const tenant = await createTenant(page);
  await page.goto(`/admin/tenants/${tenant.id}`);
  const dialog = await fillBalance(page, '充值', '20', '银行转账');
  await dialog.getByRole('button', { name: '确认充值' }).click();
  await dialog.getByRole('button', { name: '完成' }).click();

  const ledgerRequests: URL[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith(`/tenants/${tenant.id}/ledger`)
    )
      ledgerRequests.push(url);
  });
  await page.getByRole('link', { name: '余额流水' }).click();
  const range = page.getByRole('button', { name: /^日期范围（北京时间）：/ });
  await expect(range).toHaveAccessibleName(
    /：\d{4}-\d{2}-01 至 \d{4}-\d{2}-\d{2}$/,
  );
  await expect(page.getByRole('table')).toContainText('+¥20.00');
  expect(ledgerRequests).toHaveLength(1);
  const initialFrom = ledgerRequests[0]?.searchParams.get('from');
  if (!initialFrom) throw new Error('ledger request did not include from');
  const [currentYearText, currentMonthText] = initialFrom.split('-');
  if (!currentYearText || !currentMonthText)
    throw new Error(`invalid ledger date: ${initialFrom}`);
  const currentYear = Number(currentYearText);
  const currentMonth = Number(currentMonthText);
  const previousYear = currentMonth === 1 ? currentYear - 1 : currentYear;
  const previousMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const currentMonthPrefix = `${currentYearText}-${currentMonthText}`;
  const previousMonthPrefix = `${String(previousYear).padStart(4, '0')}-${String(previousMonth).padStart(2, '0')}`;
  const previousMonthLastDay = new Date(
    Date.UTC(previousYear, previousMonth, 0),
  )
    .getUTCDate()
    .toString()
    .padStart(2, '0');

  await range.click();
  const calendar = page.getByRole('dialog', { name: '日期范围（北京时间）' });
  await calendar.getByRole('button', { name: '上个月' }).click();
  await calendar
    .getByRole('button', { name: `${previousMonthPrefix}-01` })
    .click();
  await calendar.getByRole('button', { name: '下个月' }).click();
  await expect(
    calendar.getByRole('button', { name: `${currentMonthPrefix}-01` }),
  ).toBeDisabled();
  await expect(calendar.getByRole('status')).toContainText(
    `选择结束日期不能晚于 ${previousMonthPrefix}-${previousMonthLastDay}`,
  );
  await expect(calendar.getByRole('button', { name: '确定' })).toBeDisabled();
  expect(ledgerRequests).toHaveLength(1);

  await calendar.getByRole('button', { name: '上个月' }).click();
  await calendar
    .getByRole('button', { name: `${previousMonthPrefix}-02` })
    .click();
  await calendar.getByRole('button', { name: '确定' }).click();
  await expect(page.getByText('该日期范围内没有余额流水')).toBeVisible();
  await expect(page).toHaveURL(/from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-02/);
  expect(ledgerRequests).toHaveLength(2);
});
