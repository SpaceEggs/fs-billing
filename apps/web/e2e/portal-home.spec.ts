import { expect, test } from '@playwright/test';
import { accounts } from './accounts';
import { clearLoginFailures, readBeijingClock } from './db';
import { loginAs } from './helpers';

// 当前月 1 日凌晨的 20 通，03:00 之后才播种。还没播种时，最近 10 通是 9 月 29 日的尾部。

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
  // 播种月的 20 通话单：本月消费 ¥3.51、81 分钟；预存与扣费抵平，所以余额仍是 −¥35.20。
  // 该月 03:00 之前还没有这 20 通，本月消费是 0。最近话单仍是上一次播种的 1 日，没有更晚的种子月时才是 9 月 29 日。
  const clock = await readBeijingClock();
  const spend = page.getByRole('region', { name: '本月消费' });
  await expect(spend).toContainText(
    `${clock.month.slice(0, 4)}年${Number(clock.month.slice(5))}月`,
  );
  const minutes = page.getByRole('region', { name: '本月通话分钟数' });
  if (clock.seededCalls === 20) {
    await expect(spend).toContainText('¥3.51');
    await expect(minutes).toContainText('81');
    await expect(minutes).toContainText('已接通 20 通');
  } else {
    await expect(spend).toContainText('¥0.00');
    await expect(spend).not.toContainText('¥3.51');
    await expect(minutes).toContainText('已接通 0 通');
  }
  await expect(page.getByText('透支中').first()).toBeVisible();
  await expect(
    page.getByText('余额已为负数，可用额度仍有 ¥64.80'),
  ).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);

  const chart = page.getByRole('region', { name: '最近 30 天每日消费' });
  const bars = chart.getByRole('listitem');
  await expect(bars).toHaveCount(30);
  await expect(bars.last()).toHaveAttribute(
    'aria-label',
    /^\d{4}-\d\d-\d\d（今日） ¥/,
  );
  for (const label of await bars.evaluateAll((items) =>
    items.map((item) => item.getAttribute('aria-label') ?? ''),
  ))
    expect(label).not.toMatch(/通/);
  // 设计稿 1a：横轴每 5 天一个日期，共 7 个。
  await expect(page.getByTestId('chart-dates').locator('span')).toHaveCount(7);
  // 气泡是自绘的深色块，只有日期和金额。用键盘触发：窗口随当天日期滑动，种子消费日会移出窗口，
  // 悬停首根柱子可能是零消费日（柱高 0%，不可见）。
  const bubble = page.getByTestId('chart-bubble');
  await expect(bubble).toHaveCount(0);
  await chart.getByRole('list').focus();
  // 聚焦后默认显示今日。
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText(/^\d{4}-\d\d-\d\d（今日）¥[\d,.]+$/);
  // Home 跳到窗口第一天，气泡日期与首根柱子一致。
  await page.keyboard.press('Home');
  const firstDate = (await bars.first().getAttribute('aria-label'))?.split(
    ' ',
  )[0];
  await expect(bubble).toContainText(/^\d{4}-\d\d-\d\d¥[\d,.]+$/);
  await expect(bubble).toContainText(firstDate ?? '');
  await page.keyboard.press('Escape');
  await expect(bubble).toHaveCount(0);

  const calls = page
    .getByRole('region', { name: '最近话单' })
    .getByRole('table');
  await expect(
    calls.getByRole('columnheader', { name: '国家', exact: true }),
  ).toBeVisible();
  // 只有已接通的最近 10 通（表头加 10 行）：种子里 ABC001 另有一通未接通（13800138000），不会出现。
  // 有种子月时，最近的是该月 1 日凌晨那 20 通里最晚的 10 通；否则是 9 月 29 日的尾部。
  const rows = calls.getByRole('row');
  await expect(rows).toHaveCount(11);
  if (clock.latestIsSeedDay) {
    for (const [index, time, country] of [
      [1, '01:59:30', '中国'],
      [2, '01:56:04', '中国香港'],
      [4, '01:46:36', '日本'],
      [6, '01:33:54', '美国/加拿大'],
      [8, '01:21:10', '英国'],
      [10, '01:10:01', '新加坡'],
    ] as const) {
      await expect(rows.nth(index)).toContainText(
        `${clock.latestCallDay} ${time}`,
      );
      await expect(rows.nth(index)).toContainText(country);
    }
    for (const row of (await rows.all()).slice(1))
      await expect(row).toContainText(clock.latestCallDay);
  } else {
    for (const [index, time, country] of [
      [1, '13:26:25', '中国'],
      [2, '13:24:05', '中国'],
      [4, '13:16:50', '日本'],
      [9, '12:59:26', '新加坡'],
      [10, '12:54:09', '中国'],
    ] as const) {
      await expect(rows.nth(index)).toContainText(`2026-09-29 ${time}`);
      await expect(rows.nth(index)).toContainText(country);
    }
    for (const row of (await rows.all()).slice(1))
      await expect(row).toContainText('2026-09-29');
  }
  await expect(calls.getByText('13800138000')).toHaveCount(0);

  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link', { name: '首页' })).toBeVisible();
  // 阶段 7 PR 4 起门户导航有「月账单」，在「话单」与「余额流水」之间。
  await expect(nav.getByRole('link')).toHaveText([
    '首页',
    '话单',
    '月账单',
    '余额流水',
    '账号设置',
  ]);
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

test('the recent calls link to the full call list', async ({ page }) => {
  await loginAs(page, '/login', accounts.customer);
  await page
    .getByRole('region', { name: '最近话单' })
    .getByRole('link', { name: /^查看全部/ })
    .click();
  await expect(page).toHaveURL(/\/portal\/cdrs/);
  await expect(page.getByRole('heading', { name: '话单' })).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('recent calls are cards and the drawer lists the monthly statement', async ({
    page,
  }) => {
    await loginAs(page, '/login', accounts.customer);
    const clock = await readBeijingClock();
    const recent = page.getByRole('region', { name: '最近话单' });
    await expect(recent.getByRole('table')).toBeHidden();
    const cards = recent.getByRole('listitem');
    await expect(cards).toHaveCount(10);
    if (clock.latestIsSeedDay) {
      const day = clock.latestCallDay.slice(5);
      await expect(cards.first()).toContainText('中国 · 3分45秒');
      await expect(cards.first()).toContainText(`${day} 01:59:30`);
      await expect(cards.last()).toContainText('新加坡');
      await expect(cards.last()).toContainText(`${day} 01:10:01`);
    } else {
      await expect(cards.first()).toContainText('中国 · 4分11秒');
      await expect(cards.first()).toContainText('09-29 13:26:25');
      await expect(cards.last()).toContainText('中国');
      await expect(cards.last()).toContainText('09-29 12:54:09');
    }
    await expect(page.getByText('ABC001 · CNY')).toBeVisible();

    await page.getByRole('button', { name: '打开导航' }).click();
    const drawer = page.getByRole('dialog', { name: '导航' });
    await expect(drawer.getByRole('link', { name: '首页' })).toBeVisible();
    await expect(drawer.getByRole('link', { name: '月账单' })).toBeVisible();
  });

  test('the phone top bar has the ◐ theme button and the status tag has its dot', async ({
    page,
  }) => {
    await loginAs(page, '/login', accounts.customer);
    const theme = page.getByRole('button', { name: '主题' });
    await expect(theme).toBeVisible();
    await theme.click();
    await page.getByRole('menuitemradio', { name: '深色' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const tag = page.getByText('透支中').filter({ visible: true }).first();
    await expect(tag.locator('[aria-hidden]')).toBeVisible();
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
