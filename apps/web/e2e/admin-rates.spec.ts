import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { createTenant, test, uniqueCode } from './admin';
import { operationLogs } from './db';

const rates = [
  { prefix: '86', country: '中国', rate: '0.0500' },
  { prefix: '447', country: '英国手机', rate: '0.0450' },
];

const dayMs = 24 * 60 * 60 * 1000;

/** 若干天后的北京时间 HH:mm，返回选择器输入值、提交的 ISO 与页面显示。 */
function beijingSlot(daysAhead: number, time: string) {
  const date = new Date(Date.now() + 8 * 60 * 60 * 1000 + daysAhead * dayMs)
    .toISOString()
    .slice(0, 10);
  return {
    minute: `${date}T${time}`,
    iso: `${date}T${time}:00+08:00`,
    shown: `${date} ${time}:00`,
  };
}

async function readRates(page: Page, tenantId: string) {
  const response = await page.request.get(
    `/api/admin/tenants/${tenantId}/rates`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    current: { id: string; entries: typeof rates };
    scheduled: { id: string; effectiveFrom: string; entries: typeof rates }[];
  };
}

/** 通过接口排定一个单条修改，返回新版本 id。 */
async function scheduleEdit(
  page: Page,
  tenantId: string,
  entry: (typeof rates)[number],
  effectiveFrom: string,
) {
  const { current } = await readRates(page, tenantId);
  const response = await page.request.post(
    `/api/admin/tenants/${tenantId}/rates/edit-entry`,
    {
      data: {
        baseVersionId: current.id,
        entry,
        schedule: { kind: 'scheduled', effectiveFrom },
      },
    },
  );
  expect(response.status()).toBe(200);
  return ((await response.json()) as { version: { id: string } }).version.id;
}

function openRates(page: Page, tenantId: string) {
  return page.goto(`/admin/tenants/${tenantId}?tab=rates`);
}

async function openImport(page: Page, csv: string) {
  await page.getByRole('button', { name: '导入 CSV' }).click();
  const dialog = page.getByRole('dialog', { name: '导入费率表' });
  await dialog.getByLabel('选择 CSV 文件').setInputFiles({
    name: '费率_修订版.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await dialog.getByRole('button', { name: '下一步：预览' }).click();
  return dialog;
}

async function editRate(page: Page, name: string, rate: string) {
  await page.getByRole('button', { name: `编辑 ${name}` }).click();
  const form = page.getByRole('dialog', { name: '编辑费率' });
  await form.getByLabel(/费率（/).fill(rate);
  await form.getByRole('button', { name: '下一步：确认' }).click();
  return page.getByRole('dialog', { name: '确认修改费率' });
}

test('cancels selected scheduled version', async ({ page }) => {
  const tenant = await createTenant(page, { rates });
  const slot = beijingSlot(2, '09:00');
  const versionId = await scheduleEdit(
    page,
    tenant.id,
    { prefix: '447', country: '英国手机', rate: '0.0480' },
    slot.iso,
  );
  await openRates(page, tenant.id);

  const card = page.getByRole('region', { name: '排定的新版本' });
  await expect(card).toContainText(
    `${slot.shown} 起生效 · 新增 0 · 修改 1 · 删除 0`,
  );
  await expect(card.getByRole('row')).toHaveCount(2);
  await expect(card.getByRole('row').nth(1)).toHaveText(
    /修改447英国手机0\.0450\s*→\s*0\.0480\+6\.7%/,
  );

  await card.getByRole('button', { name: '取消排定' }).click();
  const dialog = page.getByRole('dialog', { name: '取消排定的新版本？' });
  await expect(dialog).toContainText(
    `原定 ${slot.shown} 起生效的新版本将被删除`,
  );
  const request = page.waitForRequest((candidate) =>
    candidate.url().endsWith('/rates/cancel-future-version'),
  );
  await dialog.getByRole('button', { name: '取消排定' }).click();
  expect((await request).postDataJSON()).toEqual({ versionId });
  await expect(
    page.getByText('已取消排定的新版本，已记入操作日志'),
  ).toBeVisible();
  await expect(card).toHaveCount(0);

  expect((await readRates(page, tenant.id)).scheduled).toEqual([]);
  const cancelled = (await operationLogs(tenant.id)).at(-1);
  expect(cancelled?.action).toBe('rate_schedule_cancel');
  expect(cancelled?.content).toMatchObject({ cancelledVersionId: versionId });
});

test('cancel inside the clock skew margin is refused with refresh', async ({
  page,
}) => {
  const tenant = await createTenant(page, { rates });
  await scheduleEdit(
    page,
    tenant.id,
    { prefix: '447', country: '英国手机', rate: '0.0480' },
    new Date(Date.now() + 50_000).toISOString(),
  );
  await openRates(page, tenant.id);
  await page
    .getByRole('region', { name: '排定的新版本' })
    .getByRole('button', { name: '取消排定' })
    .click();
  const dialog = page.getByRole('dialog', { name: '取消排定的新版本？' });
  await dialog.getByRole('button', { name: '取消排定' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    '该版本已生效或即将生效，不能取消',
  );
  await dialog.getByRole('button', { name: '刷新' }).click();
  await expect(dialog).toHaveCount(0);
});

test('minute picker submits Beijing schedule', async ({ page }) => {
  const tenant = await createTenant(page, { rates });
  await openRates(page, tenant.id);
  const confirm = await editRate(page, '447 英国手机', '0.048');
  await expect(confirm).toContainText('涨 +6.7%');
  await confirm.getByRole('radio', { name: '指定时间生效' }).check();
  const picker = confirm.getByLabel('指定生效时间（北京时间）');

  await picker.fill(beijingSlot(-1, '10:30').minute);
  await confirm.getByRole('button', { name: '确认修改' }).click();
  await expect(confirm.getByText('生效时间必须晚于当前时间')).toBeVisible();

  const slot = beijingSlot(1, '10:30');
  await picker.fill(slot.minute);
  const request = page.waitForRequest((candidate) =>
    candidate.url().endsWith('/rates/edit-entry'),
  );
  await confirm.getByRole('button', { name: '确认修改' }).click();
  expect((await request).postDataJSON()).toMatchObject({
    entry: { prefix: '447', country: '英国手机', rate: '0.048' },
    schedule: { kind: 'scheduled', effectiveFrom: slot.iso },
  });
  await expect(
    page.getByText(
      `已排定：447 英国手机 将于 ${slot.shown} 起改为 0.0480 元/分钟，已记入操作日志`,
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: '排定的新版本' }),
  ).toContainText(`${slot.shown} 起生效`);
  const { scheduled } = await readRates(page, tenant.id);
  expect(scheduled.map((version) => Date.parse(version.effectiveFrom))).toEqual(
    [Date.parse(slot.iso)],
  );
});

test('cancel edit reschedule audits each step', async ({ page }) => {
  const tenant = await createTenant(page, { rates });
  const slot = beijingSlot(3, '09:00');
  await openRates(page, tenant.id);

  // 编辑对话框打开后才有排定版本：按钮来不及禁用，由 409 兜底（G4）。
  let confirm = await editRate(page, '86 中国', '0.0550');
  const firstId = await scheduleEdit(
    page,
    tenant.id,
    { prefix: '447', country: '英国手机', rate: '0.0480' },
    slot.iso,
  );
  await confirm.getByRole('button', { name: '确认修改' }).click();
  await expect(confirm.getByRole('alert')).toContainText(
    '费率表已被修改，请刷新后重试',
  );
  await confirm.getByRole('button', { name: '刷新' }).click();
  await expect(confirm).toHaveCount(0);

  const card = page.getByRole('region', { name: '排定的新版本' });
  const edit86 = page.getByRole('button', { name: '编辑 86 中国' });
  await expect(edit86).toBeDisabled();
  await expect(edit86).toHaveAccessibleDescription(
    '已有排定的新版本，请先取消排定',
  );
  await expect(
    page.getByRole('row').filter({ hasText: '英国手机' }).last(),
  ).toContainText(`${slot.shown.slice(5, 10)} 起 0.0480`);
  await card.getByRole('button', { name: '取消排定' }).click();
  await page
    .getByRole('dialog', { name: '取消排定的新版本？' })
    .getByRole('button', { name: '取消排定' })
    .click();
  await expect(card).toHaveCount(0);

  confirm = await editRate(page, '86 中国', '0.0550');
  await confirm.getByRole('button', { name: '确认修改' }).click();
  await expect(
    page.getByText(
      '86 中国 费率已改为 0.0550 元/分钟（+10.0%），已记入操作日志',
    ),
  ).toBeVisible();

  confirm = await editRate(page, '447 英国手机', '0.0480');
  await confirm.getByRole('radio', { name: '指定时间生效' }).check();
  await confirm.getByLabel('指定生效时间（北京时间）').fill(slot.minute);
  await confirm.getByRole('button', { name: '确认修改' }).click();
  await expect(card).toContainText(
    `${slot.shown} 起生效 · 新增 0 · 修改 1 · 删除 0`,
  );

  const after = await readRates(page, tenant.id);
  expect(after.current.entries).toContainEqual({
    prefix: '86',
    country: '中国',
    rate: '0.055',
  });
  expect(after.scheduled).toHaveLength(1);
  expect(after.scheduled[0]!.entries).toEqual(
    expect.arrayContaining([
      { prefix: '86', country: '中国', rate: '0.055' },
      { prefix: '447', country: '英国手机', rate: '0.048' },
    ]),
  );
  const logs = await operationLogs(tenant.id);
  expect(logs.map((log) => log.action)).toEqual([
    'tenant_create',
    'rate_entry_edit',
    'rate_schedule_cancel',
    'rate_entry_edit',
    'rate_entry_edit',
  ]);
  expect(logs[2]!.content).toMatchObject({ cancelledVersionId: firstId });
  expect(logs[4]!.content).toMatchObject({
    rateVersionId: after.scheduled[0]!.id,
  });
});

test('exports the current version as CSV', async ({ page }) => {
  const tenant = await createTenant(page, { rates });
  await openRates(page, tenant.id);
  const { current } = await readRates(page, tenant.id);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${tenant.code}-${current.id}.csv`);
  const lines = (await readFile(await file.path(), 'utf8')).split('\n');
  expect(lines[0]).toBe('prefix,country,rate');
  expect(lines).toEqual(
    expect.arrayContaining(['86,中国,0.0500', '447,英国手机,0.0450']),
  );
  const exported = (await operationLogs(tenant.id)).at(-1);
  expect(exported?.action).toBe('rate_export');
  expect(exported?.content).toMatchObject({ rateVersionId: current.id });
});

test('exports a scheduled version as CSV from its card (G11)', async ({
  page,
}) => {
  const tenant = await createTenant(page, { rates });
  await scheduleEdit(
    page,
    tenant.id,
    { prefix: '447', country: '英国手机', rate: '0.0480' },
    beijingSlot(2, '09:00').iso,
  );
  await openRates(page, tenant.id);
  const { scheduled } = await readRates(page, tenant.id);
  const version = scheduled[0]!;
  const download = page.waitForEvent('download');
  await page
    .getByRole('region', { name: '排定的新版本' })
    .getByRole('button', { name: '导出 CSV' })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`${tenant.code}-${version.id}.csv`);
  const lines = (await readFile(await file.path(), 'utf8')).split('\n');
  expect(lines[0]).toBe('prefix,country,rate');
  expect(lines).toEqual(
    expect.arrayContaining(['86,中国,0.0500', '447,英国手机,0.0480']),
  );
  const exported = (await operationLogs(tenant.id)).at(-1);
  expect(exported?.action).toBe('rate_export');
  expect(exported?.content).toMatchObject({ rateVersionId: version.id });
});

test('shows every CSV error line', async ({ page }) => {
  const tenant = await createTenant(page, { rates });
  const before = await readRates(page, tenant.id);
  await openRates(page, tenant.id);
  const dialog = await openImport(
    page,
    [
      '前缀,国家,费率',
      '8a6,中国,0.05',
      '447,英国手机,-0.1',
      '33,法国,0.06',
      '1,美国,0.12345',
      '',
    ].join('\r\n'),
  );
  await expect(dialog.getByRole('alert')).toContainText(
    '发现 3 处错误，文件未导入',
  );
  const rows = dialog.getByRole('row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('第 2 行');
  await expect(rows.nth(1)).toContainText('8a6,中国,0.05');
  await expect(rows.nth(2)).toContainText('第 3 行');
  await expect(rows.nth(2)).toContainText('447,英国手机,-0.1');
  await expect(rows.nth(3)).toContainText('第 5 行');
  await expect(rows.nth(3)).toContainText('1,美国,0.12345');
  await expect(dialog.getByRole('button', { name: '确认导入' })).toHaveCount(0);

  expect(await readRates(page, tenant.id)).toEqual(before);
  expect((await operationLogs(tenant.id)).map((log) => log.action)).toEqual([
    'tenant_create',
  ]);
});

test('imports a CSV immediately and updates the table', async ({ page }) => {
  const tenant = await createTenant(page, { rates });
  await openRates(page, tenant.id);
  const dialog = await openImport(
    page,
    '\uFEFFprefix,country,rate\n86,中国,0.0550\n33,法国,0.0600\n',
  );
  await expect(dialog).toContainText('费率_修订版.csv · UTF-8 · 2 条');
  await expect(dialog).toContainText(
    '将新增 1 条、修改 1 条、删除 1 条，其余 0 条不变',
  );
  await expect(dialog).toContainText(
    '删除后，拨打这些前缀的呼叫将被拒绝：447 英国手机',
  );
  await expect(dialog.getByRole('row').filter({ hasText: '修改' })).toHaveText(
    /修改86中国0\.0500\s*→\s*0\.0550\+10\.0%/,
  );
  await dialog.getByRole('button', { name: '确认导入' }).click();
  await expect(dialog.getByRole('status')).toContainText('已导入，已生效');
  await expect(dialog.getByRole('status')).toContainText('已记入操作日志');
  await dialog.getByRole('button', { name: '返回费率表' }).click();
  await expect(dialog).toHaveCount(0);

  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('row').nth(1)).toContainText('33法国0.0600');
  await expect(page.getByRole('row').nth(2)).toContainText('86中国0.0550');
  const after = await readRates(page, tenant.id);
  expect(after.scheduled).toEqual([]);
  expect(after.current.entries).toEqual([
    { prefix: '33', country: '法国', rate: '0.06' },
    { prefix: '86', country: '中国', rate: '0.055' },
  ]);
  const imported = (await operationLogs(tenant.id)).at(-1);
  expect(imported?.action).toBe('rate_import');
  expect(imported?.content).toMatchObject({ rateVersionId: after.current.id });
});

test('mobile only views and searches rates', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tenant = await createTenant(page, { rates });
  await scheduleEdit(
    page,
    tenant.id,
    { prefix: '447', country: '英国手机', rate: '0.0480' },
    beijingSlot(2, '09:00').iso,
  );
  await openRates(page, tenant.id);
  const card = page.getByRole('region', { name: '排定的新版本' });
  await expect(card).toContainText('修改 1');
  await expect(card.getByRole('button', { name: '取消排定' })).toBeHidden();
  await expect(page.getByRole('button', { name: '导出 CSV' })).toBeHidden();
  await expect(page.getByRole('button', { name: '导入 CSV' })).toBeHidden();
  await expect(page.getByText('请在电脑上操作')).toBeVisible();
  await expect(page.getByRole('button', { name: /^编辑 / })).toHaveCount(0);
  await expect(card.getByRole('row').nth(1)).toContainText('447英国手机');
  await page.getByRole('searchbox', { name: '搜索前缀或国家' }).fill('英国');
  const table = page.getByRole('table').last();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table.getByRole('row').nth(1)).toContainText(
    '447英国手机0.0450',
  );
});

/** 在复制对话框里按编码搜索并选中租户，等待其费率表快照读完。 */
async function pickCopyTenant(dialog: Locator, code: string) {
  await dialog.getByLabel('搜索租户编码或名称').fill(code);
  await dialog.getByRole('radio', { name: new RegExp(code) }).check();
  await expect(dialog.getByText(/已选：.*· \d+ 条/)).toBeVisible();
}

test('pushes a full rate table to a same-currency tenant', async ({ page }) => {
  const source = await createTenant(page, {
    code: uniqueCode('CPS'),
    rates: [...rates, { prefix: '33', country: '法国', rate: '0.0600' }],
  });
  const target = await createTenant(page, {
    code: uniqueCode('CPT'),
    rates: [
      { prefix: '86', country: '中国', rate: '0.0400' },
      { prefix: '64', country: '新西兰', rate: '0.2000' },
    ],
  });
  const usd = await createTenant(page, {
    code: uniqueCode('CPU'),
    currency: 'USD',
    rates,
  });
  const sourceBefore = await readRates(page, source.id);
  const targetBefore = await readRates(page, target.id);
  await openRates(page, source.id);

  await page.getByRole('button', { name: '复制到其他租户' }).click();
  const dialog = page.getByRole('dialog', { name: '复制费率表到其他租户' });
  await expect(dialog).toContainText('将覆盖目标租户的整张费率表');
  await dialog.getByLabel('搜索租户编码或名称').fill(usd.code);
  await expect(dialog.getByText('没有匹配的同币种租户')).toBeVisible();
  await dialog.getByLabel('搜索租户编码或名称').fill(source.code);
  await expect(dialog.getByText('没有匹配的同币种租户')).toBeVisible();

  await pickCopyTenant(dialog, target.code);
  const request = page.waitForRequest((candidate) =>
    candidate.url().endsWith('/rates/copy/preview'),
  );
  await dialog.getByRole('button', { name: '下一步：预览变动' }).click();
  const preview = await request;
  expect(preview.url()).toContain(`/api/admin/tenants/${source.id}/`);
  expect(preview.postDataJSON()).toEqual({
    sourceVersionId: sourceBefore.current.id,
    targetTenantId: target.id,
    targetBaseVersionId: targetBefore.current.id,
    schedule: { kind: 'immediate' },
  });
  await expect(dialog).toContainText(
    `${target.code} 的费率表将新增 2 条、修改 1 条、删除 1 条，其余 0 条不变`,
  );
  await expect(dialog).toContainText(
    `将覆盖 ${target.code} 的整张费率表；删除后，拨打 64 新西兰 的呼叫将被拒绝`,
  );
  await dialog.getByRole('button', { name: `确认覆盖 ${target.code}` }).click();
  await expect(dialog.getByRole('status')).toContainText(
    `已复制到 ${target.code}`,
  );
  await expect(dialog.getByRole('status')).toContainText('已记入操作日志');

  const after = await readRates(page, target.id);
  expect(after.current.entries).toEqual(sourceBefore.current.entries);
  const copied = (await operationLogs(target.id)).at(-1);
  expect(copied?.action).toBe('rate_copy');
  expect(copied?.content).toMatchObject({
    rateVersionId: after.current.id,
    sourceTenantId: source.id,
    sourceVersionId: sourceBefore.current.id,
  });
});

test('pulls a rate table into an empty tenant', async ({ page }) => {
  const source = await createTenant(page, { code: uniqueCode('CPS'), rates });
  const target = await createTenant(page, { code: uniqueCode('CPE') });
  await openRates(page, target.id);
  await expect(page.getByText('费率表为空')).toBeVisible();

  await page.getByRole('button', { name: '复制其他租户的费率表' }).click();
  const dialog = page.getByRole('dialog', { name: '复制其他租户的费率表' });
  await expect(dialog).toContainText(`将覆盖 ${target.code} 的整张费率表`);
  await pickCopyTenant(dialog, source.code);
  await dialog.getByRole('button', { name: '下一步：预览变动' }).click();
  await expect(dialog).toContainText(
    `${target.code} 的费率表将新增 2 条、修改 0 条、删除 0 条，其余 0 条不变`,
  );
  await dialog.getByRole('button', { name: `确认覆盖 ${target.code}` }).click();
  await dialog.getByRole('button', { name: '完成' }).click();

  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: '编辑 447 英国手机' }),
  ).toBeVisible();
  expect((await readRates(page, target.id)).current.entries).toEqual(
    (await readRates(page, source.id)).current.entries,
  );
});
