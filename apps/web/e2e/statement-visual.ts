import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  expect,
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
import {
  backdateTenant,
  clearLoginFailures,
  recordLedgerEntry,
  recordStatementCall,
  setStatementFlags,
} from './db';
import { repoRoot, webOrigin } from './env';
import { createTenant } from './admin';

/**
 * 阶段 7 月账单视觉对照的共用部分：逐张截取实现与设计稿画框，拼成对照图，写 index.json。
 * 只由 portal-statements-visual.spec.ts 与 admin-statements-visual.spec.ts 使用，
 * 它们都只在 FSB_VISUAL=1 时运行，输出到 FSB_EVIDENCE_DIR/visual
 * （缺省为 docs/evidence/phase-7-web）。
 */
export type Theme = 'light' | 'dark';
export const themes: Theme[] = ['light', 'dark'];
export const desktopViewport = { width: 1440, height: 900 };
export const narrowViewport = { width: 1024, height: 800 };
export const phoneViewport = { width: 375, height: 812 };

export type StorageState = NonNullable<BrowserContextOptions['storageState']>;

export type Shot<Sessions extends string> = {
  name: string;
  session: Sessions;
  viewport: { width: number; height: number };
  /** 稿中没有对应画框时为 null，只存档不拼图。 */
  frame: DesignFrame | null;
  note: string | null;
  /** 打开页面并等到目标内容出现；对话框等状态也在这里打开。 */
  open: (page: Page) => Promise<void>;
  /** 对话框等只截视口，其余整页。 */
  fullPage?: boolean;
};

/** 终端颜色码（ESC [ … m），写入 index.json 前去掉。 */
const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

type IndexEntry = {
  page: string;
  theme: Theme;
  session: string;
  designFrame: DesignFrame | null;
  note: string | null;
  files: { design: string | null; app: string | null; compare: string | null };
  error?: string;
};

export function evidenceVisualDir() {
  return join(
    process.env['FSB_EVIDENCE_DIR'] ??
      join(repoRoot, 'docs/evidence/phase-7-web'),
    'visual',
  );
}

function contextOptions(
  theme: Theme,
  viewport: { width: number; height: number },
  storageState: StorageState,
): BrowserContextOptions {
  return {
    baseURL: webOrigin,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: theme,
    viewport,
    storageState,
  };
}

/** 经接口登录种子客户，返回会话；种子客户不需要先改密。 */
export async function customerSession(browser: Browser, email: string) {
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

export const seededCustomer = accounts.customer;

/** 等网络空闲、骨架屏消失。 */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-label$="加载中"]')).toHaveCount(0);
}

/**
 * 本次运行专用的租户：8 月初开户，8 月、9 月各有一笔充值与已接通电话，已生成 8、9 月账单。
 * `deleteAugust` 为真时把 8 月标为话单已删除（阶段 8 的删除功能尚未开发，用 owner 连接直接置位）。
 */
export async function statementFixture(
  admin: Page,
  options: { deleteAugust?: boolean } = {},
) {
  const tenant = await createTenant(admin);
  await backdateTenant(tenant.id, '2026-08-05T10:00:00+08:00');
  await recordLedgerEntry(tenant.id, {
    kind: 'recharge',
    amount: '1000',
    at: '2026-08-06T10:00:00+08:00',
    adminEmail: accounts.admin,
  });
  for (const [day, minutes, charge, country] of [
    ['2026-08-10', '3', '1.5', '中国'],
    ['2026-08-18', '8', '4.4', '美国/加拿大'],
    ['2026-08-18', '5', '2.5', '中国'],
  ] as const)
    await recordStatementCall(tenant.id, {
      answeredAt: `${day}T10:00:00+08:00`,
      minutes,
      charge,
      country,
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
  for (const month of ['2026-08', '2026-09']) {
    const response = await admin.request.post(
      `/api/admin/tenants/${tenant.id}/statements/${month}/regenerate`,
      { data: { expectedVersion: 0 } },
    );
    expect(response.status()).toBe(200);
  }
  if (options.deleteAugust)
    await setStatementFlags(tenant.id, '2026-08', { detailsDeleted: true });
  return tenant;
}

export async function runShots<Sessions extends string>(
  browser: Browser,
  shots: Shot<Sessions>[],
  sessions: Record<Sessions, () => Promise<StorageState>>,
  indexName: string,
) {
  const outDir = evidenceVisualDir();
  mkdirSync(outDir, { recursive: true });
  const designs = await serveDesigns();
  const designPage = await browser.newPage();
  const index: IndexEntry[] = [];
  const states = new Map<string, StorageState>();
  // 夹具租户在截图之前一次建好，浅色与深色两轮看到同样的数据。
  for (const key of Object.keys(sessions) as Sessions[])
    states.set(key, await sessions[key]());

  try {
    for (const theme of themes) {
      for (const shot of shots) {
        const entry: IndexEntry = {
          page: shot.name,
          theme,
          session: shot.session,
          designFrame: shot.frame,
          note: shot.note,
          files: { design: null, app: null, compare: null },
        };
        index.push(entry);
        const name = `${shot.name}-${theme}`;
        try {
          const context = await browser.newContext(
            contextOptions(theme, shot.viewport, states.get(shot.session)!),
          );
          try {
            await context.addInitScript(() =>
              localStorage.setItem('fs-billing.theme', 'system'),
            );
            const page = await context.newPage();
            page.setDefaultTimeout(20_000);
            await shot.open(page);
            await settle(page);
            const app = join(outDir, `app-${name}.png`);
            await page.screenshot({
              path: app,
              fullPage: shot.fullPage ?? true,
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
      join(outDir, indexName),
      `${JSON.stringify({ entries: index }, null, 2)}\n`,
    );
    await designPage.close();
    await designs.close();
  }
  return index
    .filter((entry) => entry.error)
    .map((entry) => `${entry.page}-${entry.theme}: ${entry.error}`);
}
