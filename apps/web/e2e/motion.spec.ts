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

type RefreshProbe = {
  before: string;
  after: string;
  delay: number;
  duration: number;
  short: number[];
  shortSpan: number;
  clearedAt: number;
  exitDelay: number;
  exit: { t: number; opacity: number }[];
};

async function probeRefresh(page: Page) {
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
    const before = getComputedStyle(element).opacity;

    element.setAttribute('data-refreshing', 'true');
    const entering = getComputedStyle(element);
    const delay = parse(entering.transitionDelay);
    const duration = parse(entering.transitionDuration);
    const delayMs = delay * 1000;
    const durationMs = duration * 1000;
    const holdMs =
      delayMs > durationMs
        ? Math.max(durationMs * 0.6, 48)
        : Math.max(durationMs * 0.75, 48);
    const short: number[] = [];
    const started = performance.now();
    let clearedAt = -1;
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        element.removeAttribute('data-refreshing');
        clearedAt = performance.now() - started;
      }, holdMs);
      const end = started + Math.max(delayMs, durationMs, holdMs) + 80;
      const step = () => {
        short.push(Number(getComputedStyle(element).opacity));
        if (performance.now() >= end) {
          window.clearTimeout(timer);
          if (clearedAt < 0) {
            element.removeAttribute('data-refreshing');
            clearedAt = performance.now() - started;
          }
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      step();
    });
    const shortSpan = performance.now() - started;

    element.setAttribute('data-refreshing', 'true');
    await new Promise<void>((resolve) => {
      const end = performance.now() + delayMs + durationMs + 40;
      const step = () => {
        if (performance.now() >= end) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const after = getComputedStyle(element).opacity;

    element.removeAttribute('data-refreshing');
    const exitDelay = parse(getComputedStyle(element).transitionDelay);
    const exitStart = performance.now();
    const exit: { t: number; opacity: number }[] = [];
    await new Promise<void>((resolve) => {
      const end = exitStart + Math.max(delayMs, durationMs) + 50;
      const step = () => {
        exit.push({
          t: performance.now() - exitStart,
          opacity: Number(getComputedStyle(element).opacity),
        });
        if (performance.now() >= end) {
          resolve();
          return;
        }
        requestAnimationFrame(step);
      };
      step();
    });

    element.remove();
    return {
      before,
      after,
      delay,
      duration,
      short,
      shortSpan,
      clearedAt,
      exitDelay,
      exit,
    };
  });
}

function expectRefreshCycle(
  probe: RefreshProbe,
  tokens: { fast: string; delay: string },
  reduced: boolean,
) {
  expect(probe.before).toBe('1');
  expect(Number(probe.after)).toBeCloseTo(0.72, 2);
  expect(probe.delay).toBeCloseTo(seconds(tokens.delay), 2);
  if (reduced) expect(probe.duration).toBe(0);
  else expect(probe.duration).toBeCloseTo(seconds(tokens.fast), 2);
  expect(probe.short.length).toBeGreaterThan(2);
  expect(probe.shortSpan).toBeGreaterThan(probe.delay * 1000);
  expect(probe.clearedAt).toBeGreaterThan(0);
  expect(probe.clearedAt).toBeLessThan(probe.delay * 1000);
  expect(Math.min(...probe.short)).toBeGreaterThanOrEqual(1);
  expect(probe.exitDelay).toBe(0);
  expect(probe.exit.length).toBeGreaterThan(2);
  if (reduced) expect(probe.exit[0]?.opacity).toBe(1);
  const recovered = probe.exit.find(
    (sample) => sample.opacity >= 0.99 && sample.t < probe.delay * 1000,
  );
  expect(recovered?.opacity).toBeGreaterThanOrEqual(0.99);
}

type SwitchSample = {
  opacity: number;
  animation: string;
  href: string;
  selected: string;
  panel: string;
};

async function sampleSwitch(
  page: Page,
  action: () => Promise<void>,
  settled: () => Promise<void>,
): Promise<SwitchSample[]> {
  const tokens = await motionTokens(page);
  const tailMs = Math.round(
    (seconds(tokens.delay) + seconds(tokens.fast)) * 1000,
  );
  await page.evaluate(() => {
    const read = () => {
      const nodes = document.querySelectorAll('.motion-refresh');
      let opacity = 1;
      nodes.forEach((node) => {
        opacity = Math.min(opacity, Number(getComputedStyle(node).opacity));
      });
      const main = document.querySelector('main');
      const tab = document.querySelector('[role="tab"][aria-selected="true"]');
      let selected = tab?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      if (!selected) {
        const here = new URL(location.href);
        const hereTab = here.searchParams.get('tab') ?? '';
        const links = document.querySelectorAll('nav[aria-label="租户详情"] a');
        for (let index = 0; index < links.length; index += 1) {
          const link = links[index];
          if (!(link instanceof HTMLAnchorElement)) continue;
          const url = new URL(link.href, location.origin);
          if (url.pathname !== here.pathname) continue;
          if ((url.searchParams.get('tab') ?? '') !== hereTab) continue;
          selected = link.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          break;
        }
      }
      const panel = [
        document.querySelector('[aria-label^="日期范围（北京时间）"]')
          ? '日期范围'
          : '',
        document.querySelector('section[aria-label="本月消费"]')
          ? '本月消费'
          : '',
      ]
        .filter(Boolean)
        .join(' ');
      return {
        opacity,
        animation: main ? getComputedStyle(main).animationName : 'none',
        href: `${location.pathname}${location.search}`,
        selected,
        panel,
      };
    };
    const bucket: { stop: boolean; samples: ReturnType<typeof read>[] } = {
      stop: false,
      samples: [],
    };
    (window as unknown as { __motionSwitch: typeof bucket }).__motionSwitch =
      bucket;
    const tick = () => {
      if (bucket.stop) return;
      bucket.samples.push(read());
      requestAnimationFrame(tick);
    };
    tick();
  });
  try {
    await action();
    await settled();
    return await page.evaluate((ms) => {
      const bucket = (
        window as unknown as {
          __motionSwitch: {
            stop: boolean;
            samples: SwitchSample[];
          };
        }
      ).__motionSwitch;
      return new Promise<SwitchSample[]>((resolve) => {
        window.setTimeout(() => {
          bucket.stop = true;
          resolve(bucket.samples.slice());
        }, ms);
      });
    }, tailMs);
  } finally {
    await page
      .evaluate(() => {
        const bucket = (
          window as unknown as { __motionSwitch?: { stop: boolean } }
        ).__motionSwitch;
        if (bucket) bucket.stop = true;
      })
      .catch(() => undefined);
  }
}

function expectStableSwitch(samples: SwitchSample[], parts: readonly string[]) {
  expect(samples.length).toBeGreaterThan(0);
  for (const part of parts) {
    const seen = samples.map(
      (sample) => `${sample.href} [${sample.selected}] [${sample.panel}]`,
    );
    expect(
      samples.some((sample) =>
        `${sample.href} ${sample.selected} ${sample.panel}`.includes(part),
      ),
      `${part} missing in ${String(samples.length)} samples: ${seen.slice(0, 2).join(' || ')} … ${seen.slice(-2).join(' || ')}`,
    ).toBe(true);
  }
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
  expectRefreshCycle(await probeRefresh(page), tokens, false);

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
  expectRefreshCycle(await probeRefresh(page), tokens, true);

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

  expectStableSwitch(
    await sampleSwitch(
      page,
      () => ignored.click(),
      async () => {
        await expect(page).toHaveURL(/tab=ignored/);
        await expect(ignored).toHaveAttribute('aria-selected', 'true');
      },
    ),
    ['tab=ignored', '已忽略'],
  );
  expectStableSwitch(
    await sampleSwitch(
      page,
      () => pending.click(),
      async () => {
        await expect(page).not.toHaveURL(/tab=ignored/);
        await expect(pending).toHaveAttribute('aria-selected', 'true');
      },
    ),
    ['待处理'],
  );

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
  await expect(page.locator('section[aria-label="本月消费"]')).toBeVisible();

  expectStableSwitch(
    await sampleSwitch(
      page,
      () => ledger.click(),
      async () => {
        await expect(page).toHaveURL(/tab=ledger/);
        await expect(
          page.getByRole('button', { name: /^日期范围（北京时间）：/ }),
        ).toBeVisible();
      },
    ),
    ['tab=ledger', '余额流水', '日期范围'],
  );
  expectStableSwitch(
    await sampleSwitch(
      page,
      () => overview.click(),
      async () => {
        await expect(page).not.toHaveURL(/tab=ledger/);
        await expect(overview).toHaveAttribute('aria-current', 'page');
        await expect(
          page.locator('section[aria-label="本月消费"]'),
        ).toBeVisible();
      },
    ),
    ['概况', '本月消费'],
  );
});
