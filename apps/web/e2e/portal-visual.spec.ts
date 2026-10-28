import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
  test,
  type Browser,
  type BrowserContextOptions,
  type Page,
} from '@playwright/test';
import { writeComposite } from '../scripts/screenshots/composite';
import {
  captureDesignFrame,
  serveDesigns,
  type DesignFrame,
} from '../scripts/screenshots/design-frames';
import { accounts, password } from './accounts';
import { clearLoginFailures } from './db';
import { repoRoot, webOrigin } from './env';

/**
 * 客户门户首页 1a 至 1d 与设计稿的逐张对照截图（决定 6）。只在 FSB_VISUAL=1 时运行，
 * 输出到 FSB_EVIDENCE_DIR/visual（缺省为 docs/evidence/phase-6-web），由人逐张查看 compare-*.png。
 *
 * 核对范围：电脑透支 1a、手机透支 1b、手机已停机 1c、手机无话单 1d，各含浅色与深色。
 * 电脑端的已停机与无话单稿中没有画框，只存档截图，按手机稿人工核对，不拼对照图。
 */
test.skip(
  process.env['FSB_VISUAL'] !== '1',
  '视觉对照仅在 FSB_VISUAL=1 时运行',
);

type Theme = 'light' | 'dark';
const themes: Theme[] = ['light', 'dark'];
const desktopViewport = { width: 1440, height: 900 };
const phoneViewport = { width: 375, height: 812 };

const home = '客户门户 第一批.dc.html';
const frame = (label: string): DesignFrame => ({
  file: home,
  section: '首页',
  label,
});

type Shot = {
  name: string;
  email: string;
  viewport: { width: number; height: number };
  /** 稿中没有对应画框时为 null，只存档不拼图。 */
  frame: DesignFrame | null;
  note: string | null;
  /** 页面读完后应出现的内容，用来确认截的是目标状态。 */
  ready: (page: Page) => Promise<void>;
  /** 截图前再做的操作（如悬浮在柱子上显示气泡）。 */
  prepare?: (page: Page) => Promise<void>;
};

const shots: Shot[] = [
  {
    name: 'home-overdrawn-desktop',
    email: accounts.customer,
    viewport: desktopViewport,
    frame: frame('1a 电脑 · 透支中'),
    note: null,
    ready: async (page) => {
      await expect(
        page.getByText('透支中').filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: '最近 30 天每日消费' }),
      ).toBeVisible();
    },
  },
  {
    name: 'home-overdrawn-desktop-bubble',
    email: accounts.customer,
    viewport: desktopViewport,
    frame: frame('1a 电脑 · 透支中'),
    note: '稿 1a 的气泡是静态画在今日柱上；图表窗口随运行日滑动（日期来自接口，不是浏览器时钟），种子消费止于 2026-09-29，今日一般无消费，所以气泡显示今日 ¥0.00，只对照气泡样式与位置（键盘聚焦会让图表带一圈焦点框，稿里没有）。',
    ready: async (page) => {
      await expect(
        page.getByRole('region', { name: '最近 30 天每日消费' }),
      ).toBeVisible();
    },
    prepare: async (page) => {
      // 键盘聚焦图表后气泡默认落在今日柱上，与窗口滑到哪一天无关（悬停固定日期的柱子会在种子日期移出窗口后超时）。
      await page
        .getByRole('region', { name: '最近 30 天每日消费' })
        .getByRole('list')
        .focus();
      await expect(page.getByTestId('chart-bubble')).toContainText('（今日）');
    },
  },
  {
    name: 'home-overdrawn-phone',
    email: accounts.customer,
    viewport: phoneViewport,
    frame: frame('1b 手机 · 透支中'),
    note: null,
    ready: async (page) => {
      await expect(
        page.getByText('透支中').filter({ visible: true }).first(),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: '最近 30 天每日消费' }),
      ).toBeVisible();
    },
  },
  {
    name: 'home-suspended-phone',
    email: accounts.suspendedCustomer,
    viewport: phoneViewport,
    frame: frame('1c 手机 · 已停机'),
    note: null,
    ready: async (page) => {
      await expect(page.getByRole('alert')).toContainText(
        '余额不足，已暂停呼叫',
      );
    },
  },
  {
    name: 'home-no-calls-phone',
    email: accounts.newCustomer,
    viewport: phoneViewport,
    frame: frame('1d 手机 · 新客户（无话单）'),
    note: null,
    ready: async (page) => {
      await expect(
        page.getByRole('region', { name: '没有通话记录' }),
      ).toBeVisible();
    },
  },
  {
    name: 'home-suspended-desktop',
    email: accounts.suspendedCustomer,
    viewport: desktopViewport,
    frame: null,
    note: '稿中没有电脑端已停机画框，只存档；按手机稿 1c 人工核对。',
    ready: async (page) => {
      await expect(page.getByRole('alert')).toContainText(
        '余额不足，已暂停呼叫',
      );
    },
  },
  {
    name: 'home-no-calls-desktop',
    email: accounts.newCustomer,
    viewport: desktopViewport,
    frame: null,
    note: '稿中没有电脑端无话单画框，只存档；按手机稿 1d 人工核对。',
    ready: async (page) => {
      await expect(
        page.getByRole('region', { name: '没有通话记录' }),
      ).toBeVisible();
    },
  },
];

/** 终端颜色码（ESC [ … m），写入 index.json 前去掉。 */
const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

type IndexEntry = {
  page: string;
  theme: Theme;
  account: string;
  designFrame: DesignFrame | null;
  note: string | null;
  files: { design: string | null; app: string | null; compare: string | null };
  error?: string;
};

function contextOptions(
  theme: Theme,
  viewport: Shot['viewport'],
  storageState?: BrowserContextOptions['storageState'],
): BrowserContextOptions {
  return {
    baseURL: webOrigin,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: theme,
    viewport,
    ...(storageState ? { storageState } : {}),
  };
}

/** 经接口登录，返回会话；种子客户不需要先改密。 */
async function sessionFor(browser: Browser, email: string) {
  await clearLoginFailures(email);
  const context = await browser.newContext({ baseURL: webOrigin });
  const response = await context.request.post('/api/auth/login', {
    data: { email, password: password() },
  });
  expect(response.status(), `login ${email}`).toBe(200);
  const state = await context.storageState();
  await context.close();
  return state;
}

async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-label$="加载中"]')).toHaveCount(0);
}

test('matches home frames 1a 1b 1c 1d in light and dark', async ({
  browser,
}) => {
  test.setTimeout(10 * 60_000);
  const outDir = join(
    process.env['FSB_EVIDENCE_DIR'] ??
      join(repoRoot, 'docs/evidence/phase-6-web'),
    'visual',
  );
  mkdirSync(outDir, { recursive: true });
  const designs = await serveDesigns();
  const designPage = await browser.newPage();
  const index: IndexEntry[] = [];
  const sessions = new Map<string, Awaited<ReturnType<typeof sessionFor>>>();

  try {
    for (const theme of themes) {
      for (const shot of shots) {
        const entry: IndexEntry = {
          page: shot.name,
          theme,
          account: shot.email,
          designFrame: shot.frame,
          note: shot.note,
          files: { design: null, app: null, compare: null },
        };
        index.push(entry);
        const name = `${shot.name}-${theme}`;
        try {
          if (!sessions.has(shot.email))
            sessions.set(shot.email, await sessionFor(browser, shot.email));
          const context = await browser.newContext(
            contextOptions(theme, shot.viewport, sessions.get(shot.email)),
          );
          try {
            await context.addInitScript(() =>
              localStorage.setItem('fs-billing.theme', 'system'),
            );
            const page = await context.newPage();
            page.setDefaultTimeout(20_000);
            await page.goto('/');
            await shot.ready(page);
            await settle(page);
            await shot.prepare?.(page);
            const app = join(outDir, `app-${name}.png`);
            await page.screenshot({
              path: app,
              fullPage: true,
              animations: 'disabled',
            });
            entry.files.app = app;
          } finally {
            await context.close();
          }
        } catch (error) {
          entry.error = `app: ${String(error).replace(ansiColor, '')}`;
        }
        if (!shot.frame) continue;
        const design = join(outDir, `design-${name}.png`);
        try {
          await captureDesignFrame(
            designPage,
            designs.origin,
            shot.frame,
            theme,
            design,
            15_000,
          );
          entry.files.design = design;
        } catch (error) {
          const message = `design ${shot.frame.label}: ${String(error).replace(ansiColor, '')}`;
          entry.error = entry.error ? `${entry.error}; ${message}` : message;
        }
        if (entry.files.design && entry.files.app) {
          const compare = join(outDir, `compare-${name}.png`);
          writeComposite(entry.files.design, entry.files.app, compare);
          entry.files.compare = compare;
        }
      }
    }
  } finally {
    writeFileSync(
      join(outDir, 'index.json'),
      `${JSON.stringify({ entries: index }, null, 2)}\n`,
    );
    await designPage.close();
    await designs.close();
  }
  expect(
    index
      .filter((entry) => entry.error)
      .map((e) => `${e.page}-${e.theme}: ${e.error}`),
  ).toEqual([]);
});
