import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './admin';
import {
  cdrTotals,
  ledgerAndStatementSnapshot,
  operationLogs,
  tenantBalance,
} from './db';
import {
  adminName,
  cdrTabUrl,
  currentMonth,
  deletableTenant,
  monthLabel,
} from './ops';

async function openDialog(page: Page) {
  await page.getByRole('button', { name: '删除话单' }).first().click();
  return page.getByRole('dialog', { name: '删除话单' });
}

/** 月份格翻到指定年份（格子默认打开在当前年或已选月份所在年）。 */
async function showYear(dialog: Locator, year: number) {
  for (let guard = 0; guard < 10; guard += 1) {
    const shown = Number(
      (
        await dialog
          .getByText(/^\d{4}年$/)
          .first()
          .textContent()
      )?.slice(0, 4),
    );
    if (shown === year) return;
    await dialog
      .getByRole('button', { name: shown > year ? '上一年' : '下一年' })
      .click();
  }
  throw new Error(`could not show ${year}`);
}

const monthCell = (dialog: Locator, label: string) =>
  dialog.getByRole('button', { name: new RegExp(`^${label}，`) });

async function typeCode(dialog: Locator, code: string) {
  await dialog.getByRole('textbox', { name: /请输入租户编码/ }).fill(code);
}

test('disables the current month, deletes August after the typed code, and shows the deleted notices', async ({
  page,
}) => {
  const tenant = await deletableTenant(page);
  const before = await ledgerAndStatementSnapshot(tenant.id);
  expect((await cdrTotals(tenant.id)).count).toBe(2);

  await page.goto(cdrTabUrl(tenant.id));
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: '开始月份：选择月份' }).click();
  // 当月不可选：在当前年的格子里先看当月，再翻到 2026 年。
  const current = currentMonth();
  await expect(monthCell(dialog, monthLabel(current))).toBeDisabled();
  await showYear(dialog, 2026);
  await expect(monthCell(dialog, '2026年9月')).toContainText('1 条');
  await expect(monthCell(dialog, '2026年9月')).toBeEnabled();
  await monthCell(dialog, '2026年8月').click();

  // 预览条数与时间范围（起点取开户日，终点取月末）。
  await expect(dialog).toContainText(
    `将删除 ${tenant.code} 在 2026年8月 的 1 条话单`,
  );
  await expect(dialog).toContainText(
    '时间范围 2026-08-05 00:00:00 至 2026-08-31 23:59:59（北京时间）',
  );
  await expect(dialog).toContainText('删除后无法恢复');
  await expect(dialog).toContainText(
    '原始 JSON 不随删除话单清除，按归档策略老化',
  );

  // 二次确认：编码区分大小写，输入完整才可点。
  const submit = dialog.getByRole('button', { name: '删除 1 条话单' });
  await expect(submit).toBeDisabled();
  await typeCode(dialog, tenant.code.toLowerCase());
  await expect(
    dialog.getByText(`编码不一致，请输入 ${tenant.code}`),
  ).toBeVisible();
  await expect(submit).toBeDisabled();
  await typeCode(dialog, tenant.code.slice(0, 4));
  await expect(dialog.getByText('继续输入…')).toBeVisible();
  await expect(submit).toBeDisabled();
  await typeCode(dialog, tenant.code);
  await expect(dialog.getByText('✓ 编码正确')).toBeVisible();
  await expect(submit).toBeEnabled();
  await submit.click();

  // 完成页：条数、范围、流水与账单不受影响的说明，以及操作日志链接。
  await expect(
    dialog.getByRole('heading', { name: '已删除 1 条话单' }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    `${tenant.code} · 2026年8月（2026-08-05 至 2026-08-31）`,
  );
  await expect(dialog).toContainText('2026年8月 月账单不受影响');
  await expect(dialog.getByRole('link', { name: '查看' })).toHaveAttribute(
    'href',
    `/admin/audit-logs?tenantId=${tenant.id}&label=cdr_delete`,
  );
  await dialog.getByRole('button', { name: '完成' }).click();
  await expect(dialog).toBeHidden();

  // 流水、余额、账单头部都没变；只剩 9 月那一条话单。
  expect(await ledgerAndStatementSnapshot(tenant.id)).toEqual(before);
  expect(await tenantBalance(tenant.id)).toBe(before.balance);
  expect((await cdrTotals(tenant.id)).count).toBe(1);

  // 话单标签页：范围内的已删除月份提示条，列表里没有话单。
  const banner = page.getByRole('region', { name: '已删除的话单' });
  await expect(banner).toContainText('2026年8月 的话单已删除 · 共 1 条');
  await expect(banner).toContainText(`${adminName} 删除于`);
  await expect(page.getByText('所选日期范围内没有话单')).toBeVisible();
  await expect(page.getByRole('table')).toHaveCount(0);

  // 8 月账单：导出话单明细与重新生成都不可用，并提示已删除。
  await page.goto(
    `/admin/tenants/${tenant.id}?tab=statements&statementMonth=2026-08`,
  );
  await expect(page.getByText('该月话单明细已删除').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导出 CSV（该月话单明细）' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '导出 CSV（汇总）' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '重新生成 2026年8月' }),
  ).toBeDisabled();

  // 再次打开对话框：8 月标为已删除不可选，9 月仍可删。
  await page.goto(cdrTabUrl(tenant.id));
  const again = await openDialog(page);
  await again.getByRole('button', { name: '开始月份：选择月份' }).click();
  await showYear(again, 2026);
  await expect(monthCell(again, '2026年8月')).toBeDisabled();
  await expect(monthCell(again, '2026年8月')).toContainText('已删除');
  await expect(monthCell(again, '2026年9月')).toBeEnabled();

  // 操作日志：谁、哪个租户、哪个月、多少条，带确认的编码。
  const logs = (await operationLogs(tenant.id)).filter(
    (log) => log.action === 'cdr_delete',
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]?.content).toMatchObject({
    month: '2026-08',
    deletedCount: 1,
    confirmedCode: tenant.code,
  });
});

test('deletes a two-month range one month at a time and audits each month', async ({
  page,
}) => {
  const tenant = await deletableTenant(page);
  const before = await ledgerAndStatementSnapshot(tenant.id);
  await page.goto(cdrTabUrl(tenant.id));
  const dialog = await openDialog(page);
  await dialog.getByRole('button', { name: '开始月份：选择月份' }).click();
  await showYear(dialog, 2026);
  await monthCell(dialog, '2026年8月').click();
  await dialog.getByRole('button', { name: /^结束月份：/ }).click();
  await showYear(dialog, 2026);
  await monthCell(dialog, '2026年9月').click();
  await expect(dialog).toContainText(
    `将删除 ${tenant.code} 在 2026年8月 至 2026年9月 的 2 条话单`,
  );
  await typeCode(dialog, tenant.code);
  await dialog.getByRole('button', { name: '删除 2 条话单' }).click();
  await expect(
    dialog.getByRole('heading', { name: '已删除 2 条话单' }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '完成' }).click();

  expect(await ledgerAndStatementSnapshot(tenant.id)).toEqual(before);
  expect((await cdrTotals(tenant.id)).count).toBe(0);
  const logs = (await operationLogs(tenant.id)).filter(
    (log) => log.action === 'cdr_delete',
  );
  // 月份之间不原子：每个月一个事务、一条日志，按月升序。
  expect(logs.map((log) => log.content['month'])).toEqual([
    '2026-08',
    '2026-09',
  ]);
  expect(logs.map((log) => log.content['deletedCount'])).toEqual([1, 1]);
});

test('the server refuses the current month and a wrong code even when the page is bypassed', async ({
  page,
}) => {
  const tenant = await deletableTenant(page);
  const url = `/api/admin/tenants/${tenant.id}/cdr-deletions`;
  const current = currentMonth();

  const currentMonthRequest = await page.request.post(url, {
    data: {
      fromMonth: current,
      toMonth: current,
      tenantCode: tenant.code,
      expectedCount: 0,
    },
  });
  expect(currentMonthRequest.status()).toBe(409);
  expect(await currentMonthRequest.json()).toMatchObject({
    error: { code: 'CDR_MONTH_NOT_DELETABLE' },
  });

  const wrongCode = await page.request.post(url, {
    data: {
      fromMonth: '2026-08',
      toMonth: '2026-08',
      tenantCode: tenant.code.toLowerCase(),
      expectedCount: 1,
    },
  });
  expect(wrongCode.status()).toBe(400);

  const wrongCount = await page.request.post(url, {
    data: {
      fromMonth: '2026-08',
      toMonth: '2026-08',
      tenantCode: tenant.code,
      expectedCount: 99,
    },
  });
  expect(wrongCount.status()).toBe(409);
  expect(await wrongCount.json()).toMatchObject({
    error: { code: 'CDR_DELETE_COUNT_CHANGED' },
  });
  // 三次都被拒绝，话单一条没少。
  expect((await cdrTotals(tenant.id)).count).toBe(2);
});
