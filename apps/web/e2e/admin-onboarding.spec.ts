import { expect } from '@playwright/test';
import { fillBalance, openTenants, test, uniqueCode } from './admin';

const ratesCsv = `prefix,country,rate
86,中国,0.0500
1,美国/加拿大,0.0100
44,英国,0.0200
`;

/** 验收表原为固定编码 ABC001（种子已占用）；按 Q7 改为每次运行唯一的 CNY 租户。 */
test('creates a run-unique tenant, imports rates, credits 500 and opens portal account', async ({
  page,
}) => {
  const code = uniqueCode('ONB');
  const portalEmail = `${code.toLowerCase()}@example.com`;
  await openTenants(page);
  await page.goto('/admin/tenants/new');

  await page.getByLabel(/租户编码/).fill(code);
  await page.getByLabel(/租户名称/).fill(`验收开户 ${code}`);
  await page.getByLabel(/余额提醒阈值/).fill('200');
  await page.getByLabel(/登录邮箱/).fill(portalEmail);
  await page.getByText('从 CSV 导入', { exact: true }).click();
  await page.getByLabel('CSV 文件').setInputFiles({
    name: 'rates.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(ratesCsv),
  });
  await expect(page.getByText('已选择 rates.csv')).toBeVisible();
  await page.getByRole('button', { name: '创建租户' }).click();

  const created = page.getByRole('dialog', { name: `租户 ${code} 已创建` });
  await expect(
    created.getByRole('textbox', { name: '临时密码', exact: true }),
  ).toBeVisible();
  await created.getByRole('button', { name: '查看租户' }).click();
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '¥0.00',
  );
  const detailPath = new URL(page.url()).pathname;

  await page.goto(`${detailPath}?tab=rates`);
  await expect(page.getByText('共 3 条')).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: '英国' })).toContainText(
    '0.0200',
  );

  await page.goto(detailPath);
  const dialog = await fillBalance(page, '赊账充值', '500', '合同预付');
  await dialog.getByRole('button', { name: '确认赊账充值' }).click();
  await expect(dialog.getByRole('status')).toContainText(
    '赊账充值 +¥500.00 已入账，当前余额 ¥500.00',
  );
  await dialog.getByRole('button', { name: '完成' }).click();

  await page.goto(`${detailPath}?tab=portal`);
  await expect(page.getByText(portalEmail)).toBeVisible();

  await page.goto(`/admin/tenants?search=${code}`);
  const row = page.getByRole('row').filter({ hasText: code });
  await expect(row).toContainText('正常');
  await expect(row).toContainText('¥500.00');
});
