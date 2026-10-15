import { expect } from '@playwright/test';
import { createTenant, openTenants, test } from './admin';

const emptyWarning = '未配置收件人，余额提醒无法送达';

test('warns for empty recipients after load and save', async ({ page }) => {
  await openTenants(page);
  const tenant = await createTenant(page, { emails: [] });
  await page.goto(`/admin/tenants/${tenant.id}?tab=settings`);
  const form = page.getByRole('form', { name: '租户设置' });
  await expect(form.getByText(emptyWarning)).toBeVisible();

  const recipient = `${tenant.code.toLowerCase()}@example.com`;
  const input = form.getByRole('textbox', { name: '通知邮箱', exact: true });
  await input.fill(recipient);
  await input.press('Enter');
  const added = form
    .getByRole('list', { name: '已添加的通知邮箱' })
    .getByRole('listitem');
  await expect(added).toHaveCount(1);
  await expect(added).toContainText(recipient);
  await expect(form.getByText(emptyWarning)).toHaveCount(0);
  await form.getByRole('button', { name: '保存修改' }).click();
  let confirm = page.getByRole('dialog', { name: '确认保存以下修改？' });
  await expect(confirm).toContainText(recipient);
  await expect(confirm.getByText(emptyWarning)).toHaveCount(0);
  await confirm.getByRole('button', { name: '确认保存' }).click();
  await expect(page.getByText('设置已保存，已记入操作日志')).toBeVisible();

  await form.getByRole('button', { name: `移除 ${recipient}` }).click();
  await expect(form.getByText(emptyWarning)).toBeVisible();
  await form.getByRole('button', { name: '保存修改' }).click();
  confirm = page.getByRole('dialog', { name: '确认保存以下修改？' });
  await expect(confirm.getByRole('note')).toHaveText(emptyWarning);
  await confirm.getByRole('button', { name: '确认保存' }).click();
  await expect(page.getByText('设置已保存，已记入操作日志')).toBeVisible();
  await expect(form.getByText(emptyWarning)).toBeVisible();

  await page.reload();
  await expect(
    page.getByRole('form', { name: '租户设置' }).getByText(emptyWarning),
  ).toBeVisible();
});
