import { createServer, type Server } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { accounts } from '../../e2e/accounts';
import { repoRoot } from '../../e2e/env';
import { expectPath, loginAs } from '../../e2e/helpers';
import { writeComposite } from './composite';

const designDir = join(repoRoot, 'design/设计系统规范确认');
const outDir = join(repoRoot, 'docs/evidence/phase-4-web/screenshots');
mkdirSync(outDir, { recursive: true });

type Variant = 'light' | 'dark' | 'mobile';
const variants: Variant[] = ['light', 'dark', 'mobile'];

/** 每个页面：实现的路径与登录身份，设计稿文件与要截取的画框标签。 */
const pages = {
  'customer-login': {
    path: '/login',
    login: null,
    design: '客户门户 第三批.dc.html',
    desktopFrame: { section: '登录页 电脑', label: '1a 默认' },
    mobileFrame: { section: '登录页 手机', label: '1a 手机 · 默认' },
    desktopViewport: { width: 960, height: 640 },
  },
  'admin-login': {
    path: '/admin/login',
    login: null,
    design: '管理后台 第三批 · 系统与账号.dc.html',
    desktopFrame: { section: '管理后台登录 电脑', label: '1a 默认' },
    mobileFrame: { section: '管理后台登录 手机', label: '1a 手机 · 默认' },
    desktopViewport: { width: 960, height: 640 },
  },
  'customer-404': {
    path: '/no-such-page',
    login: { page: '/login', email: accounts.customer, home: '/' },
    design: '客户门户 第三批.dc.html',
    desktopFrame: { section: '全局元素', label: '3e 电脑 · 404' },
    mobileFrame: { section: '全局元素', label: '3f 手机 · 404' },
    desktopViewport: { width: 1200, height: 560 },
  },
  'admin-404': {
    path: '/admin/no-such-page',
    login: { page: '/admin/login', email: accounts.admin, home: '/admin' },
    design: '管理后台 第三批 · 系统与账号.dc.html',
    desktopFrame: { section: '全局元素', label: '3c 电脑 · 404' },
    mobileFrame: { section: '全局元素', label: '3h 手机 · 404' },
    desktopViewport: { width: 1200, height: 560 },
  },
} as const;

const mobileViewport = { width: 375, height: 812 };

let server: Server;
let designOrigin = '';

test.beforeAll(async () => {
  server = createServer((request, response) => {
    const path = normalize(
      decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname),
    );
    const file = join(designDir, path);
    if (!file.startsWith(designDir)) return void response.writeHead(403).end();
    try {
      const type = extname(file) === '.js' ? 'text/javascript' : 'text/html';
      response
        .writeHead(200, { 'content-type': `${type}; charset=utf-8` })
        .end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No design server address');
  designOrigin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(
  () => new Promise<void>((resolve) => server.close(() => resolve())),
);

async function captureDesign(
  page: Page,
  name: keyof typeof pages,
  variant: Variant,
) {
  const spec = pages[name];
  const frame = variant === 'mobile' ? spec.mobileFrame : spec.desktopFrame;
  await page.setViewportSize({ width: 2400, height: 1600 });
  await page.goto(`${designOrigin}/${encodeURIComponent(spec.design)}`);
  const themed = page.locator('[data-theme]').first();
  await expect(themed).toBeVisible({ timeout: 30_000 });
  await themed.evaluate(
    (element, theme) => element.setAttribute('data-theme', theme),
    variant === 'dark' ? 'dark' : 'light',
  );
  const label = page
    .locator(`section[data-screen-label="${frame.section}"]`)
    .getByText(frame.label, { exact: true });
  const target = label.locator(
    'xpath=ancestor-or-self::div[1]/following-sibling::div[1]',
  );
  await target.scrollIntoViewIfNeeded();
  const path = join(outDir, `design-${name}-${variant}.png`);
  await target.screenshot({ path });
  return path;
}

async function captureApp(
  page: Page,
  name: keyof typeof pages,
  variant: Variant,
) {
  const spec = pages[name];
  await page.setViewportSize(
    variant === 'mobile' ? mobileViewport : spec.desktopViewport,
  );
  await page.emulateMedia({
    colorScheme: variant === 'dark' ? 'dark' : 'light',
  });
  await page.goto(spec.path);
  await page.evaluate(() => localStorage.setItem('fs-billing.theme', 'system'));
  await page.reload();
  await expect(
    page.getByRole('heading').filter({ visible: true }).first(),
  ).toBeVisible();
  const path = join(outDir, `app-${name}-${variant}.png`);
  await page.screenshot({ path });
  return path;
}

for (const name of Object.keys(pages) as (keyof typeof pages)[]) {
  test(name, async ({ browser }) => {
    const appContext = await browser.newContext({
      locale: 'zh-CN',
      baseURL: 'http://127.0.0.1:4173',
    });
    const appPage = await appContext.newPage();
    const login = pages[name].login;
    if (login) {
      await loginAs(appPage, login.page, login.email);
      await expectPath(appPage, login.home);
    }
    const designPage = await browser.newPage();
    for (const variant of variants) {
      const design = await captureDesign(designPage, name, variant);
      const app = await captureApp(appPage, name, variant);
      writeComposite(
        design,
        app,
        join(outDir, `compare-${name}-${variant}.png`),
      );
    }
    await appContext.close();
    await designPage.close();
  });
}
