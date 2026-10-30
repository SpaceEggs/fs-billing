import { expect, type Page } from '@playwright/test';
import { test } from './admin';
import {
  createInvalidInputAlert,
  createSystemAlert,
  recoverOpenAlerts,
  reopenAlerts,
  removeSystemAlert,
} from './db';

/** 告警设置是全局单行：用例改动之后经接口还原为「接收邮箱为空、间隔 15 分钟」，不影响后面的用例。 */
async function resetAlertSettings(page: Page) {
  const current = await page.request.get('/api/admin/alert-settings');
  expect(current.status()).toBe(200);
  const { version } = (await current.json()) as { version: number };
  const reset = await page.request.put('/api/admin/alert-settings', {
    data: { recipients: [], digestMinutes: 15, expectedVersion: version },
  });
  expect(reset.status()).toBe(200);
}

async function settingsVersion(page: Page) {
  const response = await page.request.get('/api/admin/alert-settings');
  return ((await response.json()) as { version: number }).version;
}

test('overview and system alerts settings', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByText('含已停用')).toBeVisible();
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
  const chart = page.getByRole('list', { name: '最近 30 天每日消费' });
  await chart.focus();
  await chart.press('Home');
  await expect(page.getByTestId('chart-bubble')).toBeVisible();
  await page.getByRole('button', { name: 'USD', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'USD', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: /系统告警/ })
    .click();
  await expect(page.getByRole('tab', { name: '告警列表' })).toBeVisible();
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(
    page.getByText('未设置接收邮箱，当前发给全部管理员'),
  ).toBeVisible();
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('设置未更改')).toBeVisible();
});

test('shows an open alert and its detail', async ({ page }) => {
  const id = await createSystemAlert();
  try {
    await page.goto('/admin/system-alerts');
    await expect(page.getByLabel('有进行中的告警')).toBeVisible();
    const row = page.getByRole('row').filter({ hasText: '端到端授权超时' });
    await row.getByRole('button').click();
    await expect(page.getByText('影响的通话', { exact: true })).toBeVisible();
    await expect(page.getByText('暂无通知记录')).toBeVisible();
  } finally {
    await removeSystemAlert(id);
  }
});

test('opens alert details in a phone bottom sheet', async ({ page }) => {
  const id = await createSystemAlert();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/admin/system-alerts');
    await expect(page.getByRole('tab', { name: '设置' })).toBeHidden();
    await page.getByRole('button', { name: '告警设置' }).click();
    await expect(page).toHaveURL(/tab=settings/);
    await page.getByRole('button', { name: '返回告警列表' }).click();
    await page.getByRole('button', { name: /端到端授权超时/ }).click();
    const sheet = page.getByRole('dialog', { name: '告警详情' });
    await expect(sheet.getByText('影响的通话', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  } finally {
    await removeSystemAlert(id);
  }
});

test('shows merged invalid-input alerts', async ({ page }) => {
  // 同一原因的 7 次坏推送在库里只有一条告警；页面一行，影响的通话数 7，链接带原因去未归属话单页。
  const { id, reason } = await createInvalidInputAlert(7);
  try {
    await page.goto('/admin/system-alerts');
    const rows = page.getByRole('row').filter({ hasText: reason });
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText('话单处理失败');
    await expect(rows).toContainText('进行中');
    await rows.getByRole('button').click();
    await page.getByRole('link', { name: '查看这 7 通话单 ›' }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('reason'))
      .toBe(reason);
    await expect(page).toHaveURL(/\/admin\/unassigned/);
    await expect(page.getByText(`原因筛选：${reason}`)).toBeVisible();
  } finally {
    await removeSystemAlert(id);
  }
});

test('lists the seeded alerts, filters them and expands a recovered one', async ({
  page,
}) => {
  await page.goto('/admin/system-alerts');
  const table = page.getByRole('table', { name: '系统告警' });
  await expect(table).toBeVisible();
  const total = page.getByText(/^共 \d+ 条$/);
  await expect(total).toBeVisible();
  // 种子有 5 条设计稿的示例告警，其中进行中的在最前，行底色标红。
  const rows = table.locator('tbody > tr').filter({ hasText: /进行中|已恢复/ });
  expect(await rows.count()).toBeGreaterThanOrEqual(5);
  await expect(rows.first()).toContainText('进行中');
  await expect(page.getByText(/^进行中 \d+$/)).toBeVisible();

  // 状态：只看进行中，每一行都是进行中。
  const status = page.getByRole('group', { name: '状态' });
  await status.getByRole('button', { name: '进行中' }).click();
  await expect(status.getByRole('button', { name: '进行中' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rows.filter({ hasText: '已恢复' })).toHaveCount(0);
  await expect(rows.first()).toContainText('进行中');

  // 类型 + 状态组合没有结果时给出空状态和「清除筛选」。
  await page
    .getByRole('combobox', { name: '类型' })
    .selectOption('email_failed');
  await expect(page.getByText('没有符合筛选条件的系统告警')).toBeVisible();

  // 改为只看已恢复的邮件发送失败：种子里的两条（收件人被拒、SMTP 超时）。
  await status.getByRole('button', { name: '已恢复' }).click();
  await expect(rows.first()).toContainText('邮件发送失败');
  await expect(rows.filter({ hasNotText: '邮件发送失败' })).toHaveCount(0);
  expect(await rows.count()).toBeGreaterThanOrEqual(2);

  // 展开一条已恢复的告警：持续时长、恢复时间和说明；再点一次收起。
  const first = rows.first();
  await first.getByRole('button').first().click();
  const detail = page.getByText('恢复时间', { exact: true });
  await expect(detail).toBeVisible();
  await expect(page.getByText('持续时长', { exact: true })).toBeVisible();
  await expect(page.getByText('暂无通知记录')).toBeVisible();
  await page.getByRole('button', { name: '关闭详情' }).click();
  await expect(detail).toHaveCount(0);

  // 清除筛选：回到全部。
  await page.getByRole('combobox', { name: '类型' }).selectOption('');
  await status.getByRole('button', { name: '全部' }).click();
  await expect(rows.first()).toContainText('进行中');

  // 时间窗口：24 小时是 30 天的子集。
  await page.getByRole('combobox', { name: '时间' }).selectOption('24h');
  await expect(page).toHaveURL(/window=24h/);
  await expect(total).toBeVisible();
  const day = Number(/\d+/.exec(await total.innerText())?.[0]);
  await page.getByRole('combobox', { name: '时间' }).selectOption('all');
  await expect(page).not.toHaveURL(/window=/);
  await expect
    .poll(async () => Number(/\d+/.exec(await total.innerText())?.[0]))
    .toBeGreaterThanOrEqual(day);
});

test('an empty filter result offers to clear the filters', async ({ page }) => {
  await page.goto('/admin/system-alerts');
  await page
    .getByRole('combobox', { name: '类型' })
    .selectOption('audit_failed');
  await expect(page.getByText('没有符合筛选条件的系统告警')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByRole('table', { name: '系统告警' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '类型' })).toHaveValue('');
});

test('the nav dot shows while an alert is open and disappears when none is', async ({
  page,
}) => {
  const dot = page.getByLabel('有进行中的告警');
  await page.goto('/admin');
  await expect(dot).toBeVisible();

  // 种子的进行中告警暂时标为已恢复，用例结束还原（数据库里没有别的用例同时在跑：workers = 1）。
  const reopened = await recoverOpenAlerts();
  try {
    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
    await expect(dot).toHaveCount(0);
    await page.goto('/admin/system-alerts');
    await expect(page.getByText('进行中 0', { exact: true })).toBeVisible();
    await expect(dot).toHaveCount(0);
  } finally {
    await reopenAlerts(reopened);
  }
  await page.reload();
  await expect(dot).toBeVisible();
});

test('edits the receiving mailboxes with the chips input and saves them', async ({
  page,
}) => {
  try {
    await page.goto('/admin/system-alerts');
    await page.getByRole('tab', { name: '设置' }).click();
    const input = page.getByRole('textbox', { name: '告警接收邮箱' });
    const chips = page
      .getByRole('list', { name: '已添加的告警接收邮箱' })
      .getByRole('listitem');
    await expect(
      page.getByText('未设置接收邮箱，当前发给全部管理员'),
    ).toBeVisible();

    // 回车添加；逗号、空格、分号可以一次添加多个，统一小写。
    await input.fill('Ops-Alert@Example.com');
    await input.press('Enter');
    await input.fill('b@example.com, c@example.com;d@example.com');
    await input.press('Enter');
    await expect(chips).toHaveText([
      'ops-alert@example.com',
      'b@example.com',
      'c@example.com',
      'd@example.com',
    ]);
    await expect(
      page.getByText('未设置接收邮箱，当前发给全部管理员'),
    ).toHaveCount(0);

    // 重复的地址不重复添加，并提示。
    await input.fill('OPS-alert@example.com');
    await input.press('Enter');
    await expect(chips).toHaveCount(4);
    await expect(
      page.getByText('「ops-alert@example.com」已在列表中'),
    ).toBeVisible();

    // 点移除，或在输入框为空时按退格删最后一个。
    await page.getByRole('button', { name: '移除 b@example.com' }).click();
    await expect(chips).toHaveCount(3);
    await input.press('Backspace');
    await expect(chips).toHaveText(['ops-alert@example.com', 'c@example.com']);

    // 格式不对的地址保存时被拦下，说明原因，不发请求。
    await input.fill('not-an-email');
    await input.press('Enter');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(
      page.getByText('请输入有效邮箱（最多 20 个）和 1–1440 分钟的整数'),
    ).toBeVisible();
    await page.getByRole('button', { name: '移除 not-an-email' }).click();

    // 汇总间隔：常用值与自定义共用一个值。
    await page.getByRole('button', { name: '30 分钟' }).click();
    await expect(page.getByLabel('自定义（分钟）')).toHaveValue('30');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByText('设置已保存')).toBeVisible();

    // 刷新后仍在；操作日志记了一条「修改设置」。
    await page.reload();
    await page.getByRole('tab', { name: '设置' }).click();
    await expect(chips).toHaveText(['ops-alert@example.com', 'c@example.com']);
    await expect(page.getByLabel('自定义（分钟）')).toHaveValue('30');
    const logs = await page.request.get('/api/admin/audit-logs?label=settings');
    expect(logs.status()).toBe(200);
    const { items } = (await logs.json()) as { items: { action: string }[] };
    expect(items.map((item) => item.action)).toContain('alert_settings_update');
  } finally {
    await resetAlertSettings(page);
  }
});

test('a stale settings form is rejected with a conflict and reloaded', async ({
  page,
}) => {
  try {
    await page.goto('/admin/system-alerts');
    await page.getByRole('tab', { name: '设置' }).click();
    const input = page.getByRole('textbox', { name: '告警接收邮箱' });
    await expect(input).toBeVisible();

    // 另一位管理员在这期间保存了设置：版本号前进。
    const version = await settingsVersion(page);
    const other = await page.request.put('/api/admin/alert-settings', {
      data: {
        recipients: ['other-admin@example.com'],
        digestMinutes: 5,
        expectedVersion: version,
      },
    });
    expect(other.status()).toBe(200);

    // 本页仍是旧版本；保存被拒，提示里列出自己提交的内容，表单换成最新设置。
    await input.fill('mine@example.com');
    await input.press('Enter');
    await page.getByRole('button', { name: '30 分钟' }).click();
    await page.getByRole('button', { name: '保存', exact: true }).click();
    const conflict = page.getByRole('alert').filter({
      hasText: '告警设置已被其他人修改',
    });
    await expect(conflict).toContainText('mine@example.com');
    await expect(conflict).toContainText('汇总间隔：30 分钟');
    const chips = page
      .getByRole('list', { name: '已添加的告警接收邮箱' })
      .getByRole('listitem');
    await expect(chips).toHaveText(['other-admin@example.com']);
    await expect(page.getByLabel('自定义（分钟）')).toHaveValue('5');
  } finally {
    await resetAlertSettings(page);
  }
});
