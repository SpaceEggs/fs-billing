import { expect, type Page } from '@playwright/test';
import { test } from './admin';
import {
  callChargeEntries,
  cdrTotals,
  operationLogs,
  recordUnassigned,
  tenantBalance,
} from './db';
import { uniqueCode } from './admin';
import {
  adminName,
  assignableTenant,
  assignRowsAssignable,
  assignRowsCharge,
  currentMonth,
  monthLabel,
} from './ops';

const nav = (page: Page) => page.getByRole('navigation', { name: '主导航' });
const badge = (page: Page) =>
  nav(page).getByRole('link', { name: /^未归属话单/ });
const dataRows = (page: Page) => page.getByRole('table').getByRole('row');

const summaryPending = async (page: Page) => {
  const response = await page.request.get('/api/admin/unassigned-cdrs/summary');
  expect(response.status()).toBe(200);
  return ((await response.json()) as { pending: number; ignored: number })
    .pending;
};

/** 去掉数值文本末尾多余的 0（numeric 列的小数位数不固定）。 */
const plain = (value: string) => String(Number(value));

const badgeText = (count: number) =>
  `未归属话单${count.toLocaleString('en-US')}`;

async function tenantByCode(page: Page, code: string) {
  const response = await page.request.get(
    `/api/admin/tenants?search=${code}&pageSize=5`,
  );
  const body = (await response.json()) as {
    items: { id: string; code: string }[];
  };
  const found = body.items.find((tenant) => tenant.code === code);
  if (!found) throw new Error(`tenant ${code} not found`);
  return found.id;
}

test('lists the seeded ABC01 and empty-tag groups and filters the list by group', async ({
  page,
}) => {
  await page.goto('/admin/unassigned');
  await expect(
    page.getByRole('heading', { name: '未归属话单', level: 1 }),
  ).toBeVisible();
  // 种子（设计稿未归属话单原型）：ABC01 326 条带相近租户提示，空标签 12 条。
  const abc01 = page.getByRole('button', {
    name: /标签 ABC01.*疑似拼写错误，相近：ABC001/,
  });
  await expect(abc01).toContainText('326 条');
  const empty = page.getByRole('button', { name: /话单未携带租户标签/ });
  await expect(empty).toContainText('12 条');
  await expect(page.getByRole('button', { name: /^全部/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await abc01.click();
  await expect(abc01).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('tag')).toBe('ABC01');
  await expect(
    page.getByRole('button', { name: '选择「标签 ABC01」全部 326 条' }),
  ).toBeVisible();
  // 第一页 50 行全是 ABC01。
  await expect(dataRows(page)).toHaveCount(51);
  const tags = await dataRows(page)
    .locator('td:nth-child(3)')
    .allTextContents();
  expect(tags.length).toBe(50);
  expect(new Set(tags.map((text) => text.trim()))).toEqual(new Set(['ABC01']));

  await empty.click();
  expect(new URL(page.url()).searchParams.get('tag')).toBe('');
  // 种子的 12 条空标签话单一页放得下，标签列显示「（空）」。
  await expect(dataRows(page)).toHaveCount(13);
  await expect(dataRows(page).nth(1)).toContainText('（空）');
  await expect(dataRows(page).nth(1)).toContainText('缺少租户标签');
});

test('previews the whole ABC01 group against ABC001 without charging anything', async ({
  page,
}) => {
  const abc001 = await tenantByCode(page, 'ABC001');
  const before = await tenantBalance(abc001);
  await page.goto('/admin/unassigned?tag=ABC01');
  await page
    .getByRole('button', { name: '选择「标签 ABC01」全部 326 条' })
    .click();
  await page.getByRole('button', { name: '归属到租户' }).click();
  const dialog = page.getByRole('dialog', { name: '归属到租户' });
  // 设计稿 3d、3e：单行下拉，点开后相近租户置顶并带「与标签 ABC01 相近」；选中后一行显示编码、名称和币种。
  const picker = dialog.getByRole('combobox', { name: /^归属到租户/ });
  await expect(picker).toContainText('选择租户');
  await picker.click();
  await expect(page.getByRole('option').first()).toContainText('ABC001');
  // 租户多时先搜索：按编码查到 XYZ002，清空搜索后列表恢复。
  const search = page.getByRole('combobox', { name: '搜索编码或名称' });
  await search.fill('XYZ002');
  await expect(page.getByRole('option')).toHaveCount(1);
  await expect(page.getByRole('option')).toContainText('XYZ002');
  await search.fill('');
  await expect(page.getByRole('option').first()).toContainText('ABC001');
  const option = page.getByRole('option', { name: /ABC001/ });
  await expect(option).toContainText('与标签 ABC01 相近');
  await option.click();
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(picker).toContainText('ABC001');
  await expect(picker).toContainText('（CNY）');
  // 设计稿 3e 的三个数字：324 条可归属、扣费 ¥58.35、2 条匹配不到费率。
  await expect(dialog).toContainText('实际归属324 条');
  await expect(dialog).toContainText('扣费合计¥58.35');
  await expect(dialog).toContainText('匹配不到费率2 条');
  await expect(dialog).toContainText('已选 326 条');
  await expect(dialog).toContainText('不能回溯');
  await expect(dialog).toContainText(
    `确认后从 ABC001 余额扣除 ¥58.35（-¥35.20 → -¥93.55）`,
  );
  await expect(
    dialog.getByRole('button', { name: '确认归属 324 条并扣费' }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  expect(await tenantBalance(abc001)).toBe(before);
});

test('assigns a group to the nearest tenant, charges it once and writes the ledger and the audit', async ({
  page,
}) => {
  const tenant = await assignableTenant(page);
  const pendingBefore = await summaryPending(page);
  await page.goto(`/admin/unassigned?tag=${tenant.tag}`);
  // 分组卡片提示相近租户，列表只有这四条。
  await expect(
    page.getByRole('button', {
      name: new RegExp(
        `标签 ${tenant.tag}.*疑似拼写错误，相近：${tenant.code}`,
      ),
    }),
  ).toBeVisible();
  await expect(dataRows(page)).toHaveCount(5);
  await expect(badge(page)).toHaveText(badgeText(pendingBefore));

  await page.getByRole('checkbox', { name: '选择本页' }).check();
  await expect(page.getByText('已选 4 条', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '归属到租户' }).click();
  const dialog = page.getByRole('dialog', { name: '归属到租户' });
  // 相近租户置顶并带提示。
  await dialog.getByRole('combobox', { name: /^归属到租户/ }).click();
  await expect(page.getByRole('option').first()).toContainText(tenant.code);
  const option = page.getByRole('option', { name: new RegExp(tenant.code) });
  await expect(option).toContainText(`与标签 ${tenant.tag} 相近`);
  await option.click();
  await expect(dialog).toContainText(`实际归属${assignRowsAssignable} 条`);
  await expect(dialog).toContainText(`扣费合计¥${assignRowsCharge}`);
  await expect(dialog).toContainText('匹配不到费率1 条');
  await expect(dialog).toContainText(
    `确认后从 ${tenant.code} 余额扣除 ¥${assignRowsCharge}（¥0.00 → -¥${assignRowsCharge}）`,
  );
  // 补扣费落在运行当月：对话框列出受影响的月份。
  await expect(dialog).toContainText('受影响的月份');
  await expect(dialog).toContainText(monthLabel(currentMonth()));

  const assigned = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/admin/unassigned-cdrs/assign' &&
      request.method() === 'POST',
  );
  await dialog
    .getByRole('button', { name: `确认归属 ${assignRowsAssignable} 条并扣费` })
    .click();
  await expect(dialog.getByRole('heading', { name: '归属完成' })).toBeVisible();
  await expect(dialog).toContainText(
    `已归属 ${assignRowsAssignable} 条到 ${tenant.code}，扣费 ¥${assignRowsCharge}（¥0.00 → -¥${assignRowsCharge}）`,
  );
  await expect(dialog).toContainText('1 条匹配不到费率，留在待处理');
  await dialog.getByRole('button', { name: '完成' }).click();

  // 余额与流水：三条通话扣费，合计 0.24，余额 -0.24，话单 3 条。
  expect(plain(await tenantBalance(tenant.id))).toBe(`-${assignRowsCharge}`);
  const charges = await callChargeEntries(tenant.id);
  expect(charges).toHaveLength(assignRowsAssignable);
  expect(charges.map((entry) => plain(entry.amount)).sort()).toEqual([
    '-0.04',
    '-0.1',
    '-0.1',
  ]);
  const totals = await cdrTotals(tenant.id);
  expect(totals.count).toBe(assignRowsAssignable);
  expect(plain(totals.charge)).toBe(assignRowsCharge);

  // 列表只剩没有费率的一条；导航角标同步减少 3。
  await expect(dataRows(page)).toHaveCount(2);
  await expect(dataRows(page).nth(1)).toContainText('33123456789');
  await expect(badge(page)).toHaveText(
    badgeText(pendingBefore - assignRowsAssignable),
  );

  // 同一个请求重放（同一幂等键）返回原结果，不再扣费；换新键得到「没有可归属的话单」。
  const request = await assigned;
  const body = request.postDataJSON() as { idempotencyKey: string };
  const replay = await page.request.post('/api/admin/unassigned-cdrs/assign', {
    data: body,
  });
  expect(replay.status()).toBe(200);
  expect(await replay.json()).toMatchObject({
    replayed: true,
    assigned: assignRowsAssignable,
  });
  const again = await page.request.post('/api/admin/unassigned-cdrs/assign', {
    data: { ...body, idempotencyKey: `e2e:${uniqueCode('K')}` },
  });
  expect(again.status()).toBe(409);
  expect(await again.json()).toMatchObject({
    error: { code: 'UNASSIGNED_NOTHING_TO_ASSIGN' },
  });
  expect(await callChargeEntries(tenant.id)).toHaveLength(assignRowsAssignable);
  expect(plain(await tenantBalance(tenant.id))).toBe(`-${assignRowsCharge}`);

  // 操作日志：一条归属话单；勾选本页提交的是 id 列表，所以没有分组标签。
  const logs = (await operationLogs(tenant.id)).filter(
    (log) => log.action === 'unassigned_assign',
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]?.content).toMatchObject({
    sourceTag: null,
    assignedCount: assignRowsAssignable,
    noRateCount: 1,
    chargeTotal: assignRowsCharge,
  });
});

test('ignores a row with a required reason, lists it under 已忽略, restores it, and keeps the badge in step', async ({
  page,
}) => {
  const tag = uniqueCode('IGN');
  await recordUnassigned(tag, [
    { callee: '8613800138000' },
    { callee: '8613912345678' },
  ]);
  const base = await summaryPending(page);
  await page.goto(`/admin/unassigned?tag=${tag}`);
  await expect(badge(page)).toHaveText(badgeText(base));
  await expect(dataRows(page)).toHaveCount(3);

  await page
    .getByRole('checkbox', { name: '选择 075586001234 呼 8613800138000' })
    .check();
  await page.getByRole('button', { name: '忽略', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '忽略 1 条话单' });
  // 原因必填：空着提交只提示，不发请求。
  await dialog.getByRole('button', { name: '忽略 1 条' }).click();
  await expect(dialog.getByText('请填写忽略原因')).toBeVisible();
  await dialog.getByRole('button', { name: '测试呼叫' }).click();
  await expect(dialog.getByRole('textbox', { name: '忽略原因' })).toHaveValue(
    /^测试呼叫/,
  );
  await dialog.getByRole('button', { name: '忽略 1 条' }).click();
  await expect(page.getByRole('status')).toContainText(
    '已忽略 1 条，可在「已忽略」中撤销',
  );
  await expect(dataRows(page)).toHaveCount(2);
  await expect(badge(page)).toHaveText(badgeText(base - 1));

  // 已忽略页签：原因、操作人与时间。
  await page.getByRole('tab', { name: /已忽略/ }).click();
  expect(new URL(page.url()).searchParams.get('tab')).toBe('ignored');
  const ignored = dataRows(page).filter({ hasText: '8613800138000' });
  await expect(ignored).toContainText('测试呼叫');
  await expect(ignored).toContainText(adminName);
  await ignored.getByRole('button', { name: '撤销忽略' }).click();
  await expect(page.getByRole('status')).toContainText('已撤销忽略');
  await expect(badge(page)).toHaveText(badgeText(base));

  // 回到待处理：这个标签的分组又是 2 条。
  await page.getByRole('tab', { name: /待处理/ }).click();
  await expect(
    page.getByRole('button', { name: new RegExp(`标签 ${tag} 2 条`) }),
  ).toBeVisible();
});

test('shows the pending count in the navigation badge and in the tab', async ({
  page,
}) => {
  const pending = await summaryPending(page);
  expect(pending).toBeGreaterThan(0);
  await page.goto('/admin');
  await expect(badge(page)).toHaveText(badgeText(pending));
  await badge(page).click();
  await expect(page).toHaveURL(/\/admin\/unassigned/);
  await expect(page.getByRole('tab', { name: /待处理/ })).toContainText(
    pending.toLocaleString('en-US'),
  );
  await expect(badge(page)).toHaveAttribute('aria-current', 'page');
});

test('shows the billing_tenant hint as one flowing line on both tabs', async ({
  page,
}) => {
  for (const url of ['/admin/unassigned', '/admin/unassigned?tab=ignored']) {
    await page.goto(url);
    // 运营稿 3a、3g：提示条在待处理与已忽略页签都有；文字、行内编码、后续文字排成一行，不拆成几行。
    const alert = page.locator('[data-slot="alert"]', {
      hasText: '请同时检查',
    });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText(
      '提示 请同时检查 FreeSWITCH 中的 billing_tenant 配置，否则新话单会继续进入此处。',
    );
    await expect(alert.locator('code')).toHaveText('billing_tenant');
    const box = await alert.boundingBox();
    // 一行文字加内边距约 40 px；拆成四行会超过 90 px。
    expect(box?.height).toBeLessThan(60);
  }
});

test('on a phone the action bar is fixed to the bottom and does not hide the last card', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/admin/unassigned?tag=ABC01');
  const cards = page.getByRole('main').getByRole('checkbox');
  await expect(cards.first()).toBeVisible();
  const bar = page.getByRole('region', { name: '批量操作' });
  await expect(bar).toHaveCount(0);
  await cards.first().check();
  await cards.nth(2).check();
  // 运营稿 4a：固定在视口底部，「忽略」占一份、「归属到租户 (n)」占两份。
  await expect(bar.getByRole('button', { name: '忽略' })).toBeVisible();
  await expect(
    bar.getByRole('button', { name: '归属到租户 (2)' }),
  ).toBeVisible();
  const placed = async () => {
    const box = await bar.boundingBox();
    if (!box) throw new Error('bar is not rendered');
    return box;
  };
  expect((await placed()).y + (await placed()).height).toBeCloseTo(812, 0);
  // 滚到页面最底：操作栏仍在原处，最后一张卡片完整露在它上面。
  await page.mouse.wheel(0, 100000);
  await expect
    .poll(async () =>
      page.evaluate(
        () => window.scrollY + innerHeight >= document.body.scrollHeight - 1,
      ),
    )
    .toBe(true);
  expect((await placed()).y + (await placed()).height).toBeCloseTo(812, 0);
  const lastBox = await cards.last().boundingBox();
  expect(lastBox).not.toBeNull();
  expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(
    (await placed()).y,
  );
  // 点操作栏的「忽略」打开忽略对话框，不提交。
  await bar.getByRole('button', { name: '忽略' }).click();
  await expect(
    page.getByRole('dialog', { name: /^忽略 2 条话单/ }),
  ).toBeVisible();
});
