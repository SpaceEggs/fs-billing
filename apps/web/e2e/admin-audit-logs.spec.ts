import { expect, type Page } from '@playwright/test';
import { test, uniqueCode } from './admin';
import { shanghaiDate } from './db';
import {
  adminName,
  assignableTenant,
  assignRowsAssignable,
  assignRowsCharge,
  deletableTenant,
} from './ops';

/** 用接口产生一条删除话单日志（8 月），返回租户。 */
async function deletedAugust(page: Page) {
  const tenant = await deletableTenant(page);
  const response = await page.request.post(
    `/api/admin/tenants/${tenant.id}/cdr-deletions`,
    {
      data: {
        fromMonth: '2026-08',
        toMonth: '2026-08',
        tenantCode: tenant.code,
        expectedCount: 1,
      },
    },
  );
  expect(response.status()).toBe(200);
  return tenant;
}

/** 用接口把「拼写错误」标签的一组话单整组归属给租户，返回租户。 */
async function assignedGroup(page: Page) {
  const tenant = await assignableTenant(page);
  const response = await page.request.post(
    '/api/admin/unassigned-cdrs/assign',
    {
      data: {
        tenantId: tenant.id,
        selection: { group: { tag: tenant.tag } },
        idempotencyKey: `e2e:${uniqueCode('A')}`,
        expected: {
          assignable: assignRowsAssignable,
          noRate: 1,
          chargeTotal: assignRowsCharge,
        },
      },
    },
  );
  expect(response.status()).toBe(200);
  return tenant;
}

const table = (page: Page) => page.getByRole('table', { name: '操作记录' });
const bodyRows = (page: Page) => table(page).locator('tbody > tr[tabindex]');
const select = (page: Page, name: string) =>
  page.getByRole('combobox', { name });
const tenantOption = (tenant: { code: string }) =>
  `${tenant.code} 端到端 ${tenant.code}`;

test('finds the deletion by admin, type and tenant, and expands the before and after', async ({
  page,
}) => {
  const tenant = await deletedAugust(page);
  await page.goto('/admin/audit-logs');
  await expect(
    page.getByRole('heading', { name: '操作日志', level: 1 }),
  ).toBeVisible();
  await expect(page.getByText('只读 · 记录不可修改或删除')).toBeVisible();
  await expect(table(page)).toBeVisible();

  await select(page, '租户').selectOption({ label: tenantOption(tenant) });
  await expect
    .poll(() => new URL(page.url()).searchParams.get('tenantId'))
    .toBe(tenant.id);
  await select(page, '操作类型').selectOption({ label: '删除话单' });
  await expect
    .poll(() => new URL(page.url()).searchParams.get('label'))
    .toBe('cdr_delete');
  await select(page, '管理员').selectOption({ label: adminName });
  await expect
    .poll(() => new URL(page.url()).searchParams.get('adminId'))
    .toBeTruthy();
  const params = new URL(page.url()).searchParams;
  expect(params.get('tenantId')).toBe(tenant.id);
  expect(params.get('label')).toBe('cdr_delete');
  expect(params.get('adminId')).toBeTruthy();

  // 谁、何时、哪个租户、哪个月、多少条。
  await expect(bodyRows(page)).toHaveCount(1);
  const row = bodyRows(page).first();
  await expect(row).toContainText(shanghaiDate(new Date()));
  await expect(row).toContainText(adminName);
  await expect(row).toContainText('删除话单');
  await expect(row).toContainText(tenant.code);
  await expect(row).toContainText(`删除话单 ${tenant.code} 2026年8月 1 条`);
  await expect(page.getByText('共 1 条')).toBeVisible();

  // 展开：字段、修改前、修改后，以及只读元信息。
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  const changes = page.getByRole('table', { name: '修改前后' });
  await expect(changes.getByRole('cell', { name: '条数' })).toBeVisible();
  await expect(
    changes.getByRole('cell', { name: '1', exact: true }),
  ).toBeVisible();
  await expect(
    changes.getByRole('cell', { name: '0', exact: true }),
  ).toBeVisible();
  await expect(table(page).getByText(`操作人 ${adminName} ·`)).toContainText(
    '只读记录',
  );
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
});

test('finds the assignment under 归属话单 with its tag, count and balance change', async ({
  page,
}) => {
  const tenant = await assignedGroup(page);
  await page.goto(
    `/admin/audit-logs?tenantId=${tenant.id}&label=unassigned_assign`,
  );
  await expect(bodyRows(page)).toHaveCount(1);
  const row = bodyRows(page).first();
  await expect(row).toContainText('归属话单');
  await expect(row).toContainText(tenant.code);
  await expect(row).toContainText(
    `从标签 ${tenant.tag} 归属到 ${tenant.code} ${assignRowsAssignable} 条，扣费 ¥${assignRowsCharge}`,
  );
  await expect(row).toContainText('1 条匹配不到费率未归属');
  await row.click();
  const changes = page.getByRole('table', { name: '修改前后' });
  await expect(changes).toContainText('余额');
  await expect(changes).toContainText(`-${assignRowsCharge}`);
  // 受影响的月份不进日志摘要，但归属发生在运行当月：日志日期是今天。
  await expect(row).toContainText(shanghaiDate(new Date()));
});

test('restores filters from the address on reload and reset clears them', async ({
  page,
}) => {
  const tenant = await deletedAugust(page);
  await page.goto(`/admin/audit-logs?tenantId=${tenant.id}&label=cdr_delete`);
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(select(page, '租户')).toHaveValue(tenant.id);
  await expect(select(page, '操作类型')).toHaveValue('cdr_delete');
  await page.reload();
  await expect(bodyRows(page)).toHaveCount(1);
  await expect(select(page, '操作类型')).toHaveValue('cdr_delete');

  // 非法的筛选值单独丢弃，其余保留。
  await page.goto(
    `/admin/audit-logs?tenantId=${tenant.id}&label=not-a-label&adminId=nope`,
  );
  await expect(bodyRows(page).first()).toBeVisible();
  await expect(select(page, '租户')).toHaveValue(tenant.id);
  await expect(select(page, '操作类型')).toHaveValue('');

  await page.getByRole('button', { name: '重置' }).click();
  await expect(select(page, '租户')).toHaveValue('');
  expect(new URL(page.url()).search).toBe('');
});

test('shows the empty state for a filter without matches and clears it', async ({
  page,
}) => {
  const tenant = await deletedAugust(page);
  // 另一位管理员没有删除过这个租户的话单。
  await page.goto(`/admin/audit-logs?tenantId=${tenant.id}&label=cdr_delete`);
  await expect(bodyRows(page)).toHaveCount(1);
  await select(page, '管理员').selectOption({ label: '李俊' });
  await expect(page.getByText('没有符合条件的操作记录')).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByText('没有符合条件的操作记录')).toBeHidden();
  await expect(bodyRows(page).first()).toBeVisible();

  // 日期范围早于所有记录：同样是空结果。
  await page.goto('/admin/audit-logs?from=2020-01-01&to=2020-01-31');
  await expect(page.getByText('没有符合条件的操作记录')).toBeVisible();
});
