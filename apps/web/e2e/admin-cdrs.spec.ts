import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';
import { createTenant, test } from './admin';
import {
  answeredCount,
  cdrFixture,
  cdrRates,
  septemberRange,
} from './cdr-fixtures';
import { operationLogs, recordCdrs } from './db';

async function tenantWithCdrs(page: Page) {
  const tenant = await createTenant(page, { rates: cdrRates });
  await recordCdrs(tenant.id, cdrFixture);
  return tenant;
}

const tabUrl = (id: string, extra = '') =>
  `/admin/tenants/${id}?tab=cdrs&${septemberRange}${extra}`;
const rows = (page: Page) => page.getByRole('table').getByRole('row');
const summary = (page: Page) =>
  page.getByRole('region', { name: '汇总' }).first();

test('tags the unverified call and counts it in the summary, without delete or alert links', async ({
  page,
}) => {
  const tenant = await tenantWithCdrs(page);
  await page.goto(tabUrl(tenant.id, '&status=all'));
  await expect(rows(page).nth(1)).toBeVisible();
  const jamaica = rows(page).filter({ hasText: '18765551234' });
  await expect(jamaica).toContainText('未经验证');
  await expect(jamaica).toContainText('牙买加');
  await expect(
    rows(page).filter({ hasText: '+447700900123' }),
  ).not.toContainText('未经验证');
  await expect(summary(page)).toContainText('其中未经验证 1 条');
  await expect(summary(page)).toContainText('含未接通 1');
  await expect(page.getByRole('button', { name: '删除话单' })).toHaveCount(0);
  await expect(page.getByText('查看告警')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: '话单', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

test('shows 英国 · 手机 and 英国 for the merged country column', async ({
  page,
}) => {
  const tenant = await tenantWithCdrs(page);
  await page.goto(tabUrl(tenant.id, `&country=${encodeURIComponent('英国')}`));
  await expect(rows(page)).toHaveCount(3);
  await expect(
    rows(page)
      .filter({ hasText: '+447700900123' })
      .getByRole('cell', { name: '英国 · 手机' }),
  ).toBeVisible();
  await expect(
    rows(page)
      .filter({ hasText: '00442071234567' })
      .getByRole('cell', { name: '英国', exact: true }),
  ).toBeVisible();
});

test('filters to the unverified calls and explains them without the fault time or alerts', async ({
  page,
}) => {
  const tenant = await tenantWithCdrs(page);
  await page.goto(tabUrl(tenant.id));
  await expect(rows(page)).toHaveCount(51);
  await page.getByLabel('仅看未经验证').first().click();
  await expect(page.getByLabel('仅看未经验证').first()).toBeChecked();
  await expect(rows(page)).toHaveCount(2);
  await expect(rows(page).nth(1)).toContainText('18765551234');
  const banner = page.getByText(/以下话单发生在计费系统授权超时期间/);
  await expect(banner).toHaveText(
    '未经验证：以下话单发生在计费系统授权超时期间，由 FreeSWITCH 放行，最长 30 分钟，已按费率正常计费。',
  );
  await expect(summary(page)).toContainText('全部为未经验证');
  expect(new URL(page.url()).searchParams.get('unverifiedOnly')).toBe('true');
  await expect(page.getByText(/2026-09-2\d 0\d:\d\d 起/)).toHaveCount(0);
  await expect(page.getByText('查看告警')).toHaveCount(0);
});

test('shows the verification status in the detail of the unverified call', async ({
  page,
}) => {
  const tenant = await tenantWithCdrs(page);
  await page.goto(tabUrl(tenant.id, '&unverifiedOnly=true'));
  await rows(page).nth(1).getByRole('button').click();
  const dialog = page.getByRole('dialog', { name: '话单详情' });
  await expect(dialog).toContainText('验证状态计费系统授权超时');
  await expect(dialog).toContainText(
    '计费系统故障期间由 FreeSWITCH 放行，最长 30 分钟。通话结束后已按费率补记计费，此标签仅管理后台可见。',
  );
  await expect(dialog).toContainText('牙买加');
  await expect(dialog).not.toContainText('关联告警');
});

test('exports CSV with the verification column and writes one cdr_export audit', async ({
  page,
}) => {
  const tenant = await tenantWithCdrs(page);
  await page.goto(tabUrl(tenant.id, '&status=all'));
  await expect(rows(page).nth(1)).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 CSV' }).first().click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(
    `cdrs_${tenant.code}_2026-09-01_2026-09-30.csv`,
  );
  const text = (await readFile((await file.path()) ?? '')).toString('utf8');
  const lines = text.slice(1).trimEnd().split('\r\n');
  expect(lines[0]).toContain(',通话UUID,验证状态');
  expect(lines).toHaveLength(answeredCount + 1 + 1);
  expect(lines.filter((line) => line.endsWith(',未经验证'))).toHaveLength(1);
  expect(lines.find((line) => line.includes('18765551234'))).toMatch(
    /,未经验证$/,
  );

  await expect
    .poll(async () =>
      (await operationLogs(tenant.id)).filter(
        (log) => log.action === 'cdr_export',
      ),
    )
    .toMatchObject([
      {
        action: 'cdr_export',
        content: {
          rowCount: answeredCount + 1,
          filters: {
            from: '2026-09-01',
            to: '2026-09-30',
            status: 'all',
            unverifiedOnly: false,
          },
        },
      },
    ]);
});
