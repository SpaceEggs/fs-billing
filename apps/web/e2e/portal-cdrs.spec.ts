import { readFile } from 'node:fs/promises';
import { expect, type Browser, type Page } from '@playwright/test';
import { createTenant, test } from './admin';
import {
  answeredCount,
  cdrFixture,
  cdrRates,
  septemberRange,
} from './cdr-fixtures';
import { recordCdrs, revokeSessions } from './db';
import { expectPath, submitLogin } from './helpers';
import { openPortalCustomer } from './portal';

/** 新租户（带 447 手机、44 两条英国费率）、一份话单夹具、已改密并登录的客户页面。 */
async function portalWithCdrs(
  admin: Page,
  browser: Browser,
  viewport?: { width: number; height: number },
) {
  const tenant = await createTenant(admin, { rates: cdrRates });
  await recordCdrs(tenant.id, cdrFixture);
  const customer = await openPortalCustomer(admin, browser, tenant, {
    ...(viewport ? { viewport } : {}),
  });
  return { tenant, ...customer };
}

const rows = (page: Page) => page.getByRole('table').getByRole('row');
const summary = (page: Page) =>
  page.getByRole('region', { name: '汇总' }).first();

test('shows 00:30 on the 29th for the 16:30 UTC call', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto('/portal/cdrs?from=2026-09-29&to=2026-09-29');
  await expect(rows(portal)).toHaveCount(2);
  await expect(rows(portal).nth(1)).toContainText('2026-09-29 00:30:05');
  await expect(rows(portal).nth(1)).toContainText('+447700900123');

  await portal.goto('/portal/cdrs?from=2026-09-28&to=2026-09-28');
  await expect(portal.getByText('所选日期范围内没有话单')).toBeVisible();
  await context.close();
});

test('shows 英国 · 手机 for the 447 call and 英国 for the 44 call, and lists countries only in the filter', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto(`/portal/cdrs?${septemberRange}`);
  await expect(portal.getByRole('combobox', { name: '国家' })).toBeVisible();
  await expect(
    portal.getByRole('columnheader').filter({ hasText: /国家/ }),
  ).toHaveText('国家');
  await expect(
    portal.getByRole('combobox', { name: '国家' }).getByRole('option'),
  ).toHaveText(['全部国家', '中国', '英国', '牙买加']);

  await portal.getByRole('combobox', { name: '国家' }).selectOption('英国');
  await expectPath(
    portal,
    `/portal/cdrs?${septemberRange}&country=${encodeURIComponent('英国')}`,
  );
  await expect(rows(portal)).toHaveCount(3);
  const mobile = rows(portal).filter({ hasText: '+447700900123' });
  await expect(mobile.getByRole('cell', { name: '英国 · 手机' })).toBeVisible();
  const landline = rows(portal).filter({ hasText: '00442071234567' });
  await expect(
    landline.getByRole('cell', { name: '英国', exact: true }),
  ).toBeVisible();
  await expect(summary(portal)).toContainText('通话数2');
  await expect(summary(portal)).toContainText('5分钟');
  await expect(summary(portal)).toContainText('¥0.20');
  await context.close();
});

test('searches the callee however the customer typed it', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto(`/portal/cdrs?${septemberRange}`);
  const search = portal.getByRole('searchbox', { name: '被叫号码' });
  await search.fill('+44 7700 900123');
  await expect(rows(portal)).toHaveCount(2);
  await expect(rows(portal).nth(1)).toContainText('+447700900123');
  expect(new URL(portal.url()).searchParams.get('callee')).toContain('+44');

  await search.fill('0086 138-0013 8000');
  await expect(rows(portal)).toHaveCount(2);
  await expect(rows(portal).nth(1)).toContainText('8613800138000');

  await search.fill('44a');
  await expect(
    portal.getByText('被叫号码只能包含数字、+、空格、连字符和括号'),
  ).toBeVisible();
  await expect(portal.getByRole('table')).toHaveCount(0);
  await context.close();
});

test('hides the unanswered calls by default and notes them, then lists them in the all view', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto(`/portal/cdrs?${septemberRange}`);
  await expect(summary(portal)).toContainText(`通话数${answeredCount}`);
  await expect(summary(portal)).toContainText('另有未接通 1 通');
  await expect(rows(portal)).toHaveCount(51);

  await portal.getByRole('button', { name: '全部', exact: true }).click();
  await expect(summary(portal)).toContainText('含未接通 1');
  const unanswered = rows(portal).filter({ hasText: '8613900139000' });
  await expect(unanswered).toContainText('未接通');
  await expect(unanswered).toContainText('¥0.00');
  await expect(unanswered).toHaveClass(/text-muted-foreground/);
  await context.close();
});

test('pages through 50 calls at a time', async ({ page, browser }) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto(`/portal/cdrs?${septemberRange}`);
  await expect(
    portal.getByText(`第 1–50 条，共 ${answeredCount} 条`),
  ).toBeVisible();
  await portal.getByRole('button', { name: '下一页' }).click();
  await expect(
    portal.getByText(`第 51–${answeredCount} 条，共 ${answeredCount} 条`),
  ).toBeVisible();
  await expect(rows(portal)).toHaveCount(answeredCount - 50 + 1);
  await expectPath(portal, `/portal/cdrs?${septemberRange}&page=2`);
  await context.close();
});

test('opens the call detail with the merged country and no ISO code', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto(`/portal/cdrs?from=2026-09-29&to=2026-09-29`);
  await rows(portal).nth(1).getByRole('button').click();
  const dialog = portal.getByRole('dialog', { name: '话单详情' });
  await expect(dialog).toContainText('+447700900123 · 英国 · 手机');
  await expect(dialog).toContainText('NORMAL_CLEARING（正常挂断）');
  await expect(dialog).toContainText('振铃开始2026-09-29 00:30:00');
  await expect(dialog).toContainText('挂断时间2026-09-29 00:33:55');
  await expect(dialog).toContainText('匹配的前缀447');
  await expect(dialog).toContainText('¥0.18');
  await expect(dialog).not.toContainText('GB');
  await expect(dialog).not.toContainText('验证');
  await context.close();
});

test('network responses omit unverified, and the unverified call is an ordinary row', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  const bodies: string[] = [];
  portal.on('response', (response) => {
    if (new URL(response.url()).pathname.startsWith('/api/portal/cdrs'))
      void response.text().then((text) => bodies.push(text));
  });
  await portal.goto(`/portal/cdrs?${septemberRange}&status=all`);
  const jamaica = rows(portal).filter({ hasText: '18765551234' });
  await expect(jamaica).toContainText('牙买加');
  await expect(jamaica).toContainText('13分钟');
  await expect(jamaica).toContainText('¥3.25');
  await expect(portal.getByText('未经验证')).toHaveCount(0);
  await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(2);
  for (const body of bodies)
    expect(body.toLowerCase()).not.toContain('unverified');
  await context.close();
});

test('exports the current filters as CSV with ISO, country and description columns', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser);
  await portal.goto(
    `/portal/cdrs?${septemberRange}&country=${encodeURIComponent('英国')}`,
  );
  await expect(rows(portal)).toHaveCount(3);
  const download = portal.waitForEvent('download');
  await portal.getByRole('button', { name: '导出 CSV（当前筛选）' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(
    /^cdrs_E2E[A-Z0-9]+_2026-09-01_2026-09-30\.csv$/,
  );
  const bytes = await readFile((await file.path()) ?? '');
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const lines = bytes.toString('utf8').slice(1).trimEnd().split('\r\n');
  expect(lines[0]).toBe(
    '接通时间,主叫号码,被叫号码,ISO,国家,说明,通话时长(秒),计费时长(分钟),费率,费用,振铃开始时间,挂断时间,挂断原因,匹配前缀,通话UUID',
  );
  // 按时间升序：44 的座机在前，447 的手机在后。
  expect(lines).toHaveLength(3);
  expect(lines[1]).toContain(
    '2026-09-15 10:00:05,075586001234,00442071234567,GB,英国,,60,1,0.0200,0.02,',
  );
  expect(lines[2]).toContain(
    '2026-09-29 00:30:05,075586001234,+447700900123,GB,英国,手机,230,4,0.0450,0.18,',
  );
  expect(lines[2]).toContain('NORMAL_CLEARING（正常挂断）,447,');
  expect(bytes.toString('utf8')).not.toContain('验证');
  await context.close();
});

async function expectFiltersAfterLogin(
  portal: Page,
  email: string,
  password: string,
  expected: { status: string | null; loginPath: string },
) {
  await expectPath(portal, expected.loginPath);
  await submitLogin(portal, email, password);
  await expect
    .poll(() => {
      const url = new URL(portal.url());
      return [
        url.pathname,
        url.searchParams.get('country'),
        url.searchParams.get('status'),
        url.searchParams.get('from'),
      ];
    })
    .toEqual(['/portal/cdrs', '英国', expected.status, '2026-09-01']);
  await expect(rows(portal)).toHaveCount(3);
}

test('a session that ends while the page is open asks to log in again and comes back to the same filters', async ({
  page,
  browser,
}) => {
  const {
    page: portal,
    context,
    email,
    password,
  } = await portalWithCdrs(page, browser);
  await portal.goto(
    `/portal/cdrs?${septemberRange}&country=${encodeURIComponent('英国')}`,
  );
  await expect(rows(portal)).toHaveCount(3);
  await revokeSessions(email);
  await portal.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
  const dialog = portal.getByRole('dialog', {
    name: '登录已过期，请重新登录',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '重新登录' }).click();
  await expectFiltersAfterLogin(portal, email, password, {
    status: null,
    loginPath: '/login?reason=expired',
  });
  await context.close();
});

test('changing a filter after the session ended goes to the login page and returns with the new filter', async ({
  page,
  browser,
}) => {
  const {
    page: portal,
    context,
    email,
    password,
  } = await portalWithCdrs(page, browser);
  await portal.goto(
    `/portal/cdrs?${septemberRange}&country=${encodeURIComponent('英国')}`,
  );
  await expect(rows(portal)).toHaveCount(3);
  await revokeSessions(email);
  await portal.getByRole('button', { name: '全部', exact: true }).click();
  await expectFiltersAfterLogin(portal, email, password, {
    status: 'all',
    loginPath: '/login',
  });
  await context.close();
});

test('on a phone shows cards and moves range, country and status into the filter sheet', async ({
  page,
  browser,
}) => {
  const { page: portal, context } = await portalWithCdrs(page, browser, {
    width: 390,
    height: 844,
  });
  await portal.goto(`/portal/cdrs?${septemberRange}`);
  const card = portal.getByRole('button', {
    name: /查看话单详情 \+447700900123/,
  });
  await expect(card).toBeVisible();
  await expect(card).toContainText('英国 · 手机 · 3分50秒');
  await expect(card).toContainText('09-29 00:30:05');
  await expect(portal.getByRole('table')).toBeHidden();
  await expect(portal.getByRole('combobox', { name: '国家' })).toBeHidden();

  await portal.getByRole('button', { name: '筛选', exact: true }).click();
  const sheet = portal.getByRole('dialog', { name: '筛选' });
  await expect(sheet).toContainText('最长一个月');
  await sheet.getByRole('combobox', { name: '国家' }).selectOption('牙买加');
  await expect(
    sheet.getByRole('button', { name: `查看 1 条结果` }),
  ).toBeVisible();
  await sheet.getByRole('button', { name: '查看 1 条结果' }).click();
  await expect(
    portal.getByRole('button', { name: /查看话单详情/ }),
  ).toHaveCount(1);
  await context.close();
});
