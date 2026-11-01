import { expect, type Locator, type Page } from '@playwright/test';
import { test } from './admin';

function seconds(value: string) {
  const first = value.split(',')[0]?.trim() ?? value;
  if (first.endsWith('ms')) return parseFloat(first) / 1000;
  return parseFloat(first);
}

async function animationOf(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
}

async function motionTokens(page: Page) {
  return page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    return {
      base: root.getPropertyValue('--motion-base').trim(),
      fast: root.getPropertyValue('--motion-fast').trim(),
      delay: root.getPropertyValue('--motion-delay').trim(),
    };
  });
}

async function dimAfterDelay(page: Page) {
  return page.evaluate(async () => {
    const parse = (value: string) => {
      const first = value.split(',')[0]?.trim() ?? value;
      if (first.endsWith('ms')) return parseFloat(first) / 1000;
      return parseFloat(first);
    };
    const element = document.createElement('div');
    element.className = 'motion-refresh';
    document.body.appendChild(element);
    void element.offsetWidth;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    element.setAttribute('data-refreshing', 'true');
    const start = getComputedStyle(element);
    const delay = parse(start.transitionDelay);
    const duration = parse(start.transitionDuration);
    const before = start.opacity;
    await new Promise((resolve) =>
      setTimeout(resolve, (delay + duration) * 1000 + 30),
    );
    const after = getComputedStyle(element).opacity;
    element.remove();
    return { before, after, delay, duration };
  });
}

async function sampleSwitch(page: Page, action: () => Promise<void>) {
  const samples = page.evaluate(async () => {
    const out: { opacity: number; animation: string }[] = [];
    const end = performance.now() + 300;
    while (performance.now() < end) {
      const refresh = document.querySelector('.motion-refresh');
      const main = document.querySelector('main');
      out.push({
        opacity: refresh ? Number(getComputedStyle(refresh).opacity) : 1,
        animation: main ? getComputedStyle(main).animationName : 'none',
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
    }
    return out;
  });
  await action();
  return samples;
}

function expectStableSwitch(samples: { opacity: number; animation: string }[]) {
  expect(samples.length).toBeGreaterThan(0);
  for (const sample of samples) {
    expect(sample.opacity).toBeGreaterThanOrEqual(1);
    expect(sample.animation).toBe('none');
  }
}

test('dialog motion uses tokens and reduced motion is instant', async ({
  page,
}) => {
  const nav = page.getByRole('navigation', { name: '主导航' });
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();

  const tokens = await motionTokens(page);
  expect(seconds(tokens.base)).toBeCloseTo(0.18, 2);
  expect(seconds(tokens.fast)).toBeCloseTo(0.12, 2);
  expect(seconds(tokens.delay)).toBeCloseTo(0.2, 2);

  const main = page.locator('main');
  expect((await animationOf(main)).name).toBe('none');
  const row = page.locator('[data-slot="table-body"] tr').first();
  await expect(row).toBeVisible();
  expect((await animationOf(row)).name).toBe('none');

  const refresh = page.locator('.motion-refresh').first();
  await expect(refresh).toBeVisible();
  const dim = await dimAfterDelay(page);
  expect(dim.before).toBe('1');
  expect(Number(dim.after)).toBeCloseTo(0.72, 2);
  expect(dim.delay).toBeCloseTo(seconds(tokens.delay), 2);
  expect(dim.duration).toBeCloseTo(seconds(tokens.fast), 2);

  await nav.getByRole('link', { name: '租户' }).click();
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  const route = await animationOf(main);
  expect(route.name).not.toBe('none');
  expect(seconds(route.duration)).toBeCloseTo(seconds(tokens.base), 2);

  await nav.getByRole('link', { name: '管理员' }).click();
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();
  await page.getByRole('button', { name: '＋ 新增管理员' }).click();
  const dialog = page.getByRole('dialog', { name: '新增管理员' });
  await expect(dialog).toBeVisible();

  const enter = await animationOf(dialog);
  expect(enter.name).not.toBe('none');
  expect(seconds(enter.duration)).toBeCloseTo(seconds(tokens.base), 2);

  const exit = await dialog.evaluate((element) => {
    element.setAttribute('data-state', 'closed');
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(exit.name).not.toBe('none');
  expect(seconds(exit.duration)).toBeCloseTo(seconds(tokens.fast), 2);

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();
  await nav.getByRole('link', { name: '租户' }).click();
  await expect(page).toHaveURL(/\/admin\/tenants$/);
  expect((await animationOf(main)).name).toBe('none');

  await nav.getByRole('link', { name: '管理员' }).click();
  await expect(page.getByRole('heading', { name: '管理员' })).toBeVisible();
  const reducedRefresh = page.locator('.motion-refresh').first();
  await expect(reducedRefresh).toBeVisible();
  await expect(reducedRefresh).not.toHaveAttribute('aria-busy');
  expect(
    await reducedRefresh.evaluate(
      (element) => getComputedStyle(element).transitionDuration,
    ),
  ).toBe('0s');
  const reduced = await dimAfterDelay(page);
  expect(reduced.duration).toBe(0);
  expect(reduced.delay).toBeCloseTo(seconds(tokens.delay), 2);
  expect(reduced.before).toBe('1');
  expect(Number(reduced.after)).toBeCloseTo(0.72, 2);

  await page.getByRole('button', { name: '＋ 新增管理员' }).click();
  const reducedDialog = page.getByRole('dialog', { name: '新增管理员' });
  await expect(reducedDialog).toBeVisible();
  expect((await animationOf(reducedDialog)).name).toBe('none');
});

test('search-param tab switches do not dim or replay page enter', async ({
  page,
}) => {
  await page.goto('/admin/unassigned');
  await expect(
    page.getByRole('heading', { name: '未归属话单', level: 1 }),
  ).toBeVisible();
  const pending = page.getByRole('tab', { name: /待处理/ });
  const ignored = page.getByRole('tab', { name: /已忽略/ });
  await expect(pending).toBeVisible();
  await expect(page.locator('.motion-refresh').first()).toBeVisible();

  expectStableSwitch(await sampleSwitch(page, () => ignored.click()));
  await expect(page).toHaveURL(/tab=ignored/);
  expectStableSwitch(await sampleSwitch(page, () => pending.click()));
  await expect(page).not.toHaveURL(/tab=ignored/);

  const listed = await page.request.get(
    '/api/admin/tenants?search=ABC001&pageSize=5',
  );
  expect(listed.status()).toBe(200);
  const tenant = (
    (await listed.json()) as { items: { id: string; code: string }[] }
  ).items.find((item) => item.code === 'ABC001');
  if (!tenant) throw new Error('ABC001 not found');

  await page.goto(`/admin/tenants/${tenant.id}`);
  const tenantNav = page.getByRole('navigation', { name: '租户详情' });
  await expect(tenantNav).toBeVisible();
  const overview = tenantNav.getByRole('link', { name: '概况', exact: true });
  const ledger = tenantNav.getByRole('link', { name: '余额流水', exact: true });

  await ledger.click();
  await expect(page).toHaveURL(/tab=ledger/);
  await expect(
    page.getByRole('button', { name: /^日期范围（北京时间）：/ }),
  ).toBeVisible();
  await overview.click();
  await expect(page).not.toHaveURL(/tab=ledger/);

  expectStableSwitch(await sampleSwitch(page, () => ledger.click()));
  await expect(page).toHaveURL(/tab=ledger/);
  expectStableSwitch(await sampleSwitch(page, () => overview.click()));
});
