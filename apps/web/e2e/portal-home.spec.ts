import { expect, test } from '@playwright/test';
import { accounts } from './accounts';
import { clearLoginFailures } from './db';
import { loginAs } from './helpers';

test.beforeEach(async () => {
  await clearLoginFailures(accounts.suspendedCustomer);
});

test('an overdrawn customer sees the figures, the 30-day chart and the recent answered calls', async ({
  page,
}) => {
  const home = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/portal/home' && response.ok(),
  );
  await loginAs(page, '/login', accounts.customer);
  const body = await (await home).text();
  // 门户响应没有未接通通数，也没有后台才有的未经验证标记。
  expect(body).not.toMatch(/unanswered|unverified/i);

  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '-¥35.20',
  );
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '可用额度 ¥64.80',
  );
  await expect(page.getByRole('region', { name: '透支额度' })).toContainText(
    '¥100.00',
  );
  await expect(page.getByText('透支中').first()).toBeVisible();
  await expect(
    page.getByText('余额已为负数，可用额度仍有 ¥64.80'),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const chart = page.getByRole('region', { name: '最近 30 天每日消费' });
  const bars = chart.getByRole('listitem');
  await expect(bars).toHaveCount(30);
  await expect(bars.last()).toHaveAttribute(
    'title',
    /^\d{4}-\d\d-\d\d（今日） ¥/,
  );
  for (const title of await bars.evaluateAll((items) =>
    items.map((item) => item.getAttribute('title') ?? ''),
  ))
    expect(title).not.toMatch(/通/);

  const calls = page
    .getByRole('region', { name: '最近话单' })
    .getByRole('table');
  await expect(
    calls.getByRole('columnheader', { name: '国家', exact: true }),
  ).toBeVisible();
  // 只有已接通：种子里 ABC001 另有一通未接通（13800138000），不会出现。
  await expect(calls.getByRole('row')).toHaveCount(3);
  await expect(calls.getByRole('row').nth(1)).toContainText(
    '2026-09-28 14:10:05',
  );
  await expect(calls.getByRole('row').nth(1)).toContainText('牙买加');
  await expect(calls.getByRole('row').nth(2)).toContainText(
    '2026-09-28 14:03:22',
  );
  await expect(calls.getByRole('row').nth(2)).toContainText('英国 · 手机');
  await expect(calls.getByRole('row').nth(2)).toContainText('3分50秒');
  await expect(calls.getByText('13800138000')).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link', { name: '首页' })).toBeVisible();
  await expect(nav.getByRole('link', { name: '月账单' })).toHaveCount(0);
});

test('a suspended customer sees the banner from design 1c', async ({
  page,
}) => {
  await loginAs(page, '/login', accounts.suspendedCustomer);
  const banner = page.getByRole('alert');
  await expect(banner).toContainText('余额不足，已暂停呼叫');
  await expect(banner).toContainText('请联系客服充值，到账后自动恢复呼叫。');
  await expect(page.getByText('已停机').first()).toBeVisible();
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '-¥100.36',
  );
});

test('a customer without calls sees the empty state and no chart', async ({
  page,
}) => {
  await loginAs(page, '/login', accounts.newCustomer);
  const empty = page.getByRole('region', { name: '没有通话记录' });
  await expect(empty).toContainText('没有通话记录');
  await expect(
    page.getByRole('region', { name: '最近 30 天每日消费' }),
  ).toHaveCount(0);
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '当前余额' })).toContainText(
    '-$4.82',
  );
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('recent calls are cards and the drawer has no monthly statement', async ({
    page,
  }) => {
    await loginAs(page, '/login', accounts.customer);
    const recent = page.getByRole('region', { name: '最近话单' });
    await expect(recent.getByRole('table')).toBeHidden();
    const cards = recent.getByRole('listitem');
    await expect(cards).toHaveCount(2);
    await expect(cards.last()).toContainText('英国 · 手机 · 3分50秒');
    await expect(page.getByText('ABC001 · CNY')).toBeVisible();

    await page.getByRole('button', { name: '打开导航' }).click();
    const drawer = page.getByRole('dialog', { name: '导航' });
    await expect(drawer.getByRole('link', { name: '首页' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: '月账单' })).toHaveCount(0);
  });

  test('a suspended customer sees the banner above the figures', async ({
    page,
  }) => {
    await loginAs(page, '/login', accounts.suspendedCustomer);
    const banner = page.getByRole('alert');
    await expect(banner).toBeVisible();
    const bannerBox = (await banner.boundingBox())!;
    const figuresBox = (await page
      .getByRole('region', { name: '当前余额' })
      .boundingBox())!;
    expect(bannerBox.y).toBeLessThan(figuresBox.y);
  });
});
