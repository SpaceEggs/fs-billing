import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page } from '@playwright/test';
import { accounts } from './accounts';
import { createTenant, test } from './admin';
import {
  backdateTenant,
  operationLogs,
  recordLedgerEntry,
  recordStatementCall,
  setStatementFlags,
  shanghaiDate,
} from './db';

const abc001 = '/admin/statements';
const tenantTab = (id: string, extra = '') =>
  `/admin/tenants/${id}?tab=statements${extra}`;

/** 北京时间的当前月与上一个月，格式 YYYY-MM。 */
function currentMonth() {
  return shanghaiDate(new Date()).slice(0, 7);
}

function previousMonth() {
  const [year, month] = currentMonth().split('-').map(Number) as [
    number,
    number,
  ];
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

const monthLabel = (month: string) =>
  `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

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

/** 列表页里某个租户的行（电脑版表格）。 */
const listRow = (page: Page, code: string) =>
  page
    .locator('tbody tr')
    .filter({ has: page.getByText(code, { exact: true }) });

/**
 * 本次运行专用的租户：8 月初开户，8 月、9 月各有一笔充值与一通已接通电话，
 * 10 月（当前月）没有活动。重新生成会改动账单，所以不用 ABC001。
 */
async function fixtureTenant(
  page: Page,
  options: { currency?: 'CNY' | 'USD' } = {},
) {
  const tenant = await createTenant(page, options);
  await backdateTenant(tenant.id, '2026-08-05T10:00:00+08:00');
  await recordLedgerEntry(tenant.id, {
    kind: 'recharge',
    amount: '1000',
    at: '2026-08-06T10:00:00+08:00',
    adminEmail: accounts.admin,
  });
  await recordStatementCall(tenant.id, {
    answeredAt: '2026-08-10T10:00:00+08:00',
    minutes: '3',
    charge: '1.5',
  });
  await recordLedgerEntry(tenant.id, {
    kind: 'recharge',
    amount: '200',
    at: '2026-09-03T10:00:00+08:00',
    adminEmail: accounts.admin,
  });
  await recordStatementCall(tenant.id, {
    answeredAt: '2026-09-12T10:00:00+08:00',
    minutes: '4',
    charge: '2',
    country: '牙买加',
  });
  return tenant;
}

/** 经接口生成某月账单（等同补建，expectedVersion 为 0）。 */
async function generate(page: Page, tenantId: string, month: string) {
  const response = await page.request.post(
    `/api/admin/tenants/${tenantId}/statements/${month}/regenerate`,
    { data: { expectedVersion: 0 } },
  );
  expect(response.status()).toBe(200);
}

async function regenerateViaApi(
  page: Page,
  tenantId: string,
  month: string,
  expectedVersion: number,
) {
  const response = await page.request.post(
    `/api/admin/tenants/${tenantId}/statements/${month}/regenerate`,
    { data: { expectedVersion } },
  );
  expect(response.status()).toBe(200);
  return (await response.json()) as {
    changed: boolean;
    after: { version: number };
    staleFollowingMonths: string[];
  };
}

async function confirmRegenerate(page: Page, trigger: Locator) {
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: /^重新生成 .+ 账单？$/ });
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  return dialog;
}

test('adds 账单 to the admin navigation after 待收款 and defaults to the previous month', async ({
  page,
}) => {
  await page.goto('/admin');
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link')).toHaveText([
    '概览',
    '租户',
    '待收款',
    '账单',
    '管理员',
  ]);
  await nav.getByRole('link', { name: '账单' }).click();
  await expect(page).toHaveURL(abc001);
  await expect(
    page.getByRole('heading', { name: '账单', level: 1 }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('button', { name: `月份：${monthLabel(previousMonth())}` })
      .first(),
  ).toBeVisible();
  // 默认的上月已是最晚可选月份。
  await expect(
    page.getByRole('button', { name: '月份：下个月' }).first(),
  ).toBeDisabled();
  await expect(nav.getByRole('link', { name: '账单' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

test('shows the ABC001 August and September statements of the mockup', async ({
  page,
}) => {
  await page.goto('/admin/statements?month=2026-08');
  const august = listRow(page, 'ABC001');
  await expect(august).toContainText('¥0.00');
  await expect(august).toContainText('¥3,000.00');
  await expect(august).toContainText('¥50.00');
  await expect(august).toContainText('¥1,873.40');
  await expect(august).toContainText('¥1,176.60');
  await expect(
    page.getByRole('region', { name: 'CNY 账单' }).getByText(/个租户/),
  ).toBeVisible();

  await page.goto('/admin/statements?month=2026-09');
  const september = listRow(page, 'ABC001');
  await expect(september).toContainText('¥1,176.60');
  await expect(september).toContainText('¥1,300.00');
  await expect(september).toContainText('-¥25.50');
  await expect(september).toContainText('¥2,486.30');
  await expect(september).toContainText('-¥35.20');
  await expect(september).toContainText('2026-');
});

test('groups by currency and the footer total equals the sum of the generated rows', async ({
  page,
}) => {
  const usd = await fixtureTenant(page, { currency: 'USD' });
  const cny = await fixtureTenant(page);
  await generate(page, usd.id, '2026-09');
  await generate(page, cny.id, '2026-09');
  await page.goto('/admin/statements?month=2026-09');
  const cnyGroup = page.getByRole('region', { name: 'CNY 账单' });
  const usdGroup = page.getByRole('region', { name: 'USD 账单' });
  await expect(
    cnyGroup.getByText(`${cny.code}`, { exact: true }),
  ).toBeVisible();
  await expect(
    usdGroup.getByText(`${usd.code}`, { exact: true }),
  ).toBeVisible();
  await expect(cnyGroup.getByText(usd.code, { exact: true })).toHaveCount(0);
  await expect(listRow(page, usd.code)).toContainText('$200.00');
  await expect(listRow(page, cny.code)).toContainText('¥200.00');

  // 合计由服务端算，不是前端求和：这里用各行的充值列核对（未生成的行没有数字，不计入）。
  for (const group of [cnyGroup, usdGroup]) {
    const cells = await group
      .locator('tbody tr')
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelectorAll('td')[3]?.textContent ?? ''),
      );
    const cents = (text: string) => {
      const match = /(-?)[¥$]([\d,]+)\.(\d\d)/.exec(text);
      return match
        ? (match[1] ? -1 : 1) *
            Number(match[2]!.replaceAll(',', '') + match[3]!)
        : 0;
    };
    const total = await group.locator('tfoot td').nth(2).textContent();
    expect(cells.reduce((sum, cell) => sum + cents(cell), 0)).toBe(
      cents(total ?? ''),
    );
  }
});

test('lists a tenant without a statement as 未生成 and regenerating creates it', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await page.goto('/admin/statements?month=2026-09');
  const row = listRow(page, tenant.code);
  await expect(row).toContainText('未生成');
  await expect(row.getByRole('button', { name: /^重新生成/ })).toBeEnabled();

  const dialog = await confirmRegenerate(
    page,
    row.getByRole('button', { name: /^重新生成/ }),
  );
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText(
    `已生成 ${tenant.code} 2026年9月 账单（版本 1），已记入操作日志`,
  );
  await expect(row).not.toContainText('未生成');
  await expect(row).toContainText('¥200.00');
  await expect(row).toContainText('¥2.00');
  await expect(row).toContainText('¥1,196.50');

  const logs = (await operationLogs(tenant.id)).filter(
    (log) => log.action === 'statement_regenerate',
  );
  expect(logs).toHaveLength(1);
  expect(logs[0]?.content).toMatchObject({
    month: '2026-09',
    created: true,
    changed: true,
    before: null,
    after: { version: 1, callCharges: '2', calls: 1 },
  });
});

test('regenerating after a late call updates the figures, bumps the version and audits before and after', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-09');
  await page.goto('/admin/statements?month=2026-09');
  const row = listRow(page, tenant.code);
  await expect(row).toContainText('¥2.00');

  await recordStatementCall(tenant.id, {
    answeredAt: '2026-09-20T10:00:00+08:00',
    minutes: '10',
    charge: '5',
  });
  await row.getByRole('button', { name: /^重新生成/ }).click();
  const dialog = page.getByRole('dialog', { name: /^重新生成 .+ 账单？$/ });
  await expect(dialog).toContainText('¥2.00 · 4分钟');
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(page.getByRole('status')).toContainText(
    `已重新生成 ${tenant.code} 2026年9月 账单（版本 2）：通话扣费 ¥2.00 → ¥7.00`,
  );
  await expect(row).toContainText('¥7.00');
  await expect(row).toContainText('已重新生成 · 原');

  const logs = (await operationLogs(tenant.id)).filter(
    (log) => log.action === 'statement_regenerate',
  );
  expect(logs.at(-1)?.content).toMatchObject({
    month: '2026-09',
    created: false,
    changed: true,
    before: { version: 1, callCharges: '2' },
    after: { version: 2, callCharges: '7' },
  });
});

test('regenerating an unchanged month keeps the version and says nothing changed', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-09');
  await page.goto(tenantTab(tenant.id));
  const row = page.locator('tbody tr').filter({ hasText: '2026年9月' });
  await confirmRegenerate(
    page,
    row.getByRole('button', { name: '重新生成 2026年9月' }),
  );
  await expect(page.getByRole('status')).toContainText(
    '账单与当前话单一致，没有变化（版本 1 不变），已记入操作日志',
  );
  const logs = (await operationLogs(tenant.id)).filter(
    (log) => log.action === 'statement_regenerate',
  );
  // 补建一次，这次无变化再记一次。
  expect(logs).toHaveLength(2);
  expect(logs.at(-1)?.content).toMatchObject({
    changed: false,
    created: false,
  });
});

test('lists the later months that went stale and does not regenerate them', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-08');
  await generate(page, tenant.id, '2026-09');
  // 补推 8 月的一通电话：8 月的期末变了，9 月存下的期初就过期了。
  await recordStatementCall(tenant.id, {
    answeredAt: '2026-08-20T10:00:00+08:00',
    minutes: '6',
    charge: '3',
  });
  await page.goto(tenantTab(tenant.id));
  const august = page.locator('tbody tr').filter({ hasText: '2026年8月' });
  await confirmRegenerate(
    page,
    august.getByRole('button', { name: '重新生成 2026年8月' }),
  );
  const notice = page.getByText('后续月份的账单已过期').locator('..');
  await expect(notice).toContainText('2026年9月');
  await expect(notice).toContainText('请按月份顺序逐个重新生成');
  // 只处理点选的月份：9 月仍是版本 1，存下的期初（8 月原来的期末）没变。
  await page.goto(tenantTab(tenant.id, '&statementMonth=2026-09'));
  await expect(page.getByLabel('账单信息')).toContainText('v1');
  await expect(
    page.getByRole('region', { name: '账单汇总' }).first(),
  ).toContainText('¥998.50');
  // 管理员按提示接着处理 9 月，之后不再有后续过期月份。
  const next = await regenerateViaApi(page, tenant.id, '2026-09', 1);
  expect(next.changed).toBe(true);
  expect(next.staleFollowingMonths).toEqual([]);
});

test('a second tab that regenerated first makes the first tab fail with a version conflict', async ({
  page,
  context,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-09');
  await page.goto(tenantTab(tenant.id));
  const row = page.locator('tbody tr').filter({ hasText: '2026年9月' });
  await row.getByRole('button', { name: '重新生成 2026年9月' }).click();
  const dialog = page.getByRole('dialog', { name: /^重新生成 .+ 账单？$/ });
  await expect(dialog).toContainText('¥2.00 · 4分钟');

  // 另一个标签页先重新生成（话单有变化，版本加 1）。
  await recordStatementCall(tenant.id, {
    answeredAt: '2026-09-21T10:00:00+08:00',
    minutes: '1',
    charge: '0.5',
  });
  const second = await context.newPage();
  await second.goto(tenantTab(tenant.id));
  await second
    .locator('tbody tr')
    .filter({ hasText: '2026年9月' })
    .getByRole('button', { name: '重新生成 2026年9月' })
    .click();
  await second
    .getByRole('dialog')
    .getByRole('button', { name: '重新生成', exact: true })
    .click();
  await expect(second.getByRole('status')).toContainText('版本 2');

  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    '账单已被重新生成，请刷新后重试',
  );
  await expect(
    dialog.getByRole('button', { name: '重新生成', exact: true }),
  ).toBeDisabled();
  // 没有重复生成：只有两条审计（补建、第二个标签页的重新生成）。
  expect(
    (await operationLogs(tenant.id)).filter(
      (log) => log.action === 'statement_regenerate',
    ),
  ).toHaveLength(2);
  // 刷新后列表显示最新版本，可再次打开对话框。
  await dialog.getByRole('button', { name: '刷新' }).click();
  await expect(dialog).toHaveCount(0);
  await row.getByRole('button', { name: '重新生成 2026年9月' }).click();
  await expect(dialog).toContainText('¥2.50 · 5分钟');
});

test('greys the current month and a month with deleted CDRs, each with its reason', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-08');
  await generate(page, tenant.id, '2026-09');
  await setStatementFlags(tenant.id, '2026-08', { detailsDeleted: true });
  await page.goto(tenantTab(tenant.id));
  const current = page
    .locator('tbody tr')
    .filter({ hasText: monthLabel(currentMonth()) });
  await expect(current).toContainText('本月（进行中）');
  await expect(current).toContainText('进行中，月结后可重新生成');
  await expect(
    current.getByRole('button', {
      name: `重新生成 ${monthLabel(currentMonth())}`,
    }),
  ).toBeDisabled();
  const august = page.locator('tbody tr').filter({ hasText: '2026年8月' });
  await expect(august).toContainText('话单已删除');
  await expect(august).toContainText('话单已删除，无法重新计算');
  await expect(
    august.getByRole('button', { name: '重新生成 2026年8月' }),
  ).toBeDisabled();
  await expect(page.getByText(/2026年8月的话单明细已被删除/)).toBeVisible();

  // 月份页的同一行：置灰并带备注。
  await page.goto('/admin/statements?month=2026-08');
  const row = listRow(page, tenant.code);
  await expect(row).toContainText('该月话单已删除');
  const button = row.getByRole('button', { name: /^重新生成/ });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', '话单已删除，无法重新计算');
});

test('shows the reconcile state in the generation-time note slot, the tab and the detail', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-08');
  await generate(page, tenant.id, '2026-09');
  await setStatementFlags(tenant.id, '2026-08', {
    reconcileStatus: 'stale',
    reconcileDiff: '3',
  });
  await setStatementFlags(tenant.id, '2026-09', {
    reconcileStatus: 'inconsistent',
    reconcileDiff: '-1.25',
  });

  await page.goto('/admin/statements?month=2026-08');
  await expect(listRow(page, tenant.code)).toContainText('账单已过期');
  await page.goto('/admin/statements?month=2026-09');
  await expect(listRow(page, tenant.code)).toContainText('账单与流水不一致');

  await page.goto(tenantTab(tenant.id));
  await expect(
    page.locator('tbody tr').filter({ hasText: '2026年8月' }),
  ).toContainText('账单已过期');
  await expect(
    page.locator('tbody tr').filter({ hasText: '2026年9月' }),
  ).toContainText('账单与流水不一致');

  await page.goto(tenantTab(tenant.id, '&statementMonth=2026-09'));
  await expect(page.getByLabel('账单信息')).toContainText('账单与流水不一致');
  await expect(page.getByLabel('账单信息')).toContainText('-¥1.25');
});

test('opens the ABC001 September statement from the tab with the mockup figures and zero-filled days', async ({
  page,
}) => {
  const id = await tenantByCode(page, 'ABC001');
  await page.goto(tenantTab(id));
  const nav = page.getByRole('navigation', { name: '租户详情' });
  await expect(nav.getByRole('link')).toHaveText([
    '概况',
    '余额流水',
    '费率',
    '话单',
    '账单',
    '设置',
    '门户账号',
  ]);
  await expect(nav.getByRole('link', { name: '账单' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const august = page.locator('tbody tr').filter({ hasText: '2026年8月' });
  await expect(august).toContainText('¥1,176.60');
  await expect(august).toContainText('37,468分钟');
  const september = page.locator('tbody tr').filter({ hasText: '2026年9月' });
  await expect(september).toContainText('-¥35.20');
  await expect(september).toContainText('49,726分钟');

  await august.getByRole('link', { name: '查看 2026年8月' }).click();
  await expect(page).toHaveURL(tenantTab(id, '&statementMonth=2026-08'));
  await expect(page.getByText('2026-08-12（开户）至 2026-08-31')).toBeVisible();
  const summary = page.getByRole('region', { name: '账单汇总' }).first();
  await expect(summary).toContainText('¥3,000.00');
  await expect(summary).toContainText('¥50.00');
  await expect(summary).toContainText('9,642 通 · 37,468分钟');
  await expect(summary).toContainText('¥1,176.60');
  const countries = page.getByRole('region', { name: '按国家汇总' });
  await expect(
    countries.getByRole('cell', { name: '中国', exact: true }),
  ).toBeVisible();
  await expect(
    countries.getByRole('cell', { name: '牙买加', exact: true }),
  ).toBeVisible();
  const days = page.getByRole('region', { name: '按日汇总' });
  await expect(days).toContainText('20 天');
  await expect(days.locator('tbody tr')).toHaveCount(20);
  await expect(days.locator('tbody tr').first()).toContainText('2026-08-12');
  await expect(page.getByLabel('账单信息')).toContainText('v1');
  // 种子数据的话单与流水一致，没有差额提示。
  await expect(page.getByRole('note')).toHaveCount(0);

  await nav.getByRole('link', { name: '账单' }).click();
  await expect(page).toHaveURL(tenantTab(id));
});

test('exports the summary CSV and the month CDR CSV, and prints', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-09');
  await page.addInitScript(() => {
    (window as unknown as { printed: number }).printed = 0;
    window.print = () => {
      (window as unknown as { printed: number }).printed += 1;
    };
  });
  await page.goto(tenantTab(tenant.id, '&statementMonth=2026-09'));
  await expect(page.getByRole('heading', { name: '2026年9月' })).toBeVisible();

  const summaryDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV（汇总）' }).click();
  const summaryFile = await summaryDownload;
  expect(summaryFile.suggestedFilename()).toBe(
    `statement_${tenant.code}_2026-09-01_2026-09-30.csv`,
  );
  const summary = (await readFile((await summaryFile.path()) ?? ''))
    .toString('utf8')
    .slice(1)
    .trimEnd()
    .split('\r\n');
  expect(summary[0]).toBe('类别,项目,通话数,计费分钟,金额（CNY）');
  expect(summary).toContain('汇总,充值,,,200');
  expect(summary).toContain('汇总,通话扣费,1,4,-2');
  expect(summary).toContain('国家,牙买加,1,4,2');
  expect(summary).toContain('日期,2026-09-12,1,4,2');

  const cdrDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV（该月话单明细）' }).click();
  const cdrFile = await cdrDownload;
  const cdrLines = (await readFile((await cdrFile.path()) ?? ''))
    .toString('utf8')
    .slice(1)
    .trimEnd()
    .split('\r\n');
  expect(cdrLines).toHaveLength(2);
  expect(cdrLines[1]).toContain('牙买加');

  // 明细 CSV 复用话单导出，后台照常写 cdr_export；汇总 CSV 不写操作日志。
  await expect
    .poll(async () =>
      (await operationLogs(tenant.id)).filter(
        (log) => log.action === 'cdr_export',
      ),
    )
    .toHaveLength(1);
  expect(
    (await operationLogs(tenant.id)).filter(
      (log) => log.action === 'statement_export',
    ),
  ).toHaveLength(0);

  await page.getByRole('button', { name: '打印' }).click();
  expect(
    await page.evaluate(
      () => (window as unknown as { printed: number }).printed,
    ),
  ).toBe(1);
});

test('disables the CDR detail export once the month CDRs are deleted but keeps the summary export', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-09');
  await setStatementFlags(tenant.id, '2026-09', { detailsDeleted: true });
  await page.goto(tenantTab(tenant.id, '&statementMonth=2026-09'));
  await expect(page.getByText('该月话单明细已删除').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: '导出 CSV（该月话单明细）' }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '导出 CSV（汇总）' }),
  ).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '重新生成 2026年9月' }),
  ).toBeDisabled();
});

test('hides the navigation and buttons when printing', async ({ page }) => {
  const id = await tenantByCode(page, 'ABC001');
  await page.goto(tenantTab(id, '&statementMonth=2026-08'));
  await expect(page.getByRole('heading', { name: '2026年8月' })).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: '租户详情' })).toBeHidden();
  await expect(page.getByRole('button', { name: '打印' })).toBeHidden();
  await expect(page.getByRole('region', { name: '账单汇总' })).toBeVisible();
});

test('shows the month cards and the actions sheet on a phone', async ({
  page,
}) => {
  const tenant = await fixtureTenant(page);
  await generate(page, tenant.id, '2026-09');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/statements?month=2026-09');
  await expect(
    page.getByRole('button', { name: `${tenant.code} 的操作` }),
  ).toBeVisible();
  await expect(page.locator('table:visible')).toHaveCount(0);
  await page.getByRole('button', { name: `${tenant.code} 的操作` }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('link', { name: '查看' })).toBeVisible();
  await sheet.getByRole('button', { name: '重新生成' }).click();
  await expect(
    page.getByRole('dialog', {
      name: `重新生成 ${tenant.code} 2026年9月 账单？`,
    }),
  ).toBeVisible();
});
