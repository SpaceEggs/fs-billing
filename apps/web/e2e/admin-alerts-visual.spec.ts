import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { DesignFrame } from '../scripts/screenshots/design-frames';
import { test } from './admin';
import { repoRoot } from './env';
import {
  customerSession,
  runShots,
  seededCustomer,
  type Shot,
  type StorageState,
} from './statement-visual';

/**
 * 阶段 9 概览、系统告警与月账单（#82 对齐修复之后）与设计稿的逐张对照，浅色与深色各一遍，
 * 宽度 1440、1024、768、390（沿用阶段 6 至 8 的做法，另加平板宽度）。设计稿只有电脑与手机两种画框：
 * 1440 对电脑画框，390 对手机画框，1024 与 768 也对电脑画框（它们在稿里没有对应版式，差异另记）。
 * 只在 FSB_VISUAL=1 时运行，输出到 FSB_EVIDENCE_DIR/visual（缺省 docs/evidence/phase-9-web），由人逐张查看 compare-*.png。
 *
 * 不改种子：「一切正常」「没有告警」两个状态用接口拦截渲染（同阶段 8 的 3h），其余都是种子里的真实数据。
 */
process.env['FSB_EVIDENCE_DIR'] ??= join(repoRoot, 'docs/evidence/phase-9-web');

test.skip(
  process.env['FSB_VISUAL'] !== '1',
  '视觉对照仅在 FSB_VISUAL=1 时运行',
);

const operations = '管理后台 第三批 · 运营.dc.html';
const portal = '客户门户 第二批.dc.html';
const frame = (file: string, section: string, label: string): DesignFrame => ({
  file,
  section,
  label,
});

const widths = [
  { key: '1440', viewport: { width: 1440, height: 900 } },
  { key: '1024', viewport: { width: 1024, height: 800 } },
  { key: '768', viewport: { width: 768, height: 1024 } },
  { key: '390', viewport: { width: 390, height: 844 } },
] as const;
type Width = (typeof widths)[number];
const phone = (width: Width) => width.key === '390';

type Session = 'admin' | 'abc001';

const overviewOpen = async (page: Page) => {
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: '需要关注' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: '最近 30 天每日消费' }),
  ).toBeVisible();
};

/** 概览的「一切正常」：把真实响应里的需要关注清空，其余数字照旧。 */
const overviewAllClear = async (page: Page) => {
  await page.route('**/api/admin/overview', async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as {
      metrics: { suspendedTenants: number };
      attention: Record<string, unknown>;
    };
    body.metrics.suspendedTenants = 0;
    body.attention = {
      suspended: { total: 0, items: [] },
      lowBalance: { total: 0, items: [] },
      unassigned: { pending: 0 },
      alerts: { open: 0, last24h: 0, items: [] },
    };
    await route.fulfill({ response, json: body });
  });
  await page.goto('/admin');
  await expect(page.getByText('一切正常')).toBeVisible();
  await page.getByRole('button', { name: 'USD', exact: true }).click();
};

const alertsOpen = async (page: Page) => {
  await page.goto('/admin/system-alerts');
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: '进行中' })
      .first()
      .or(page.getByRole('button', { name: /进行中/ }).first()),
  ).toBeVisible();
};

/** 展开 9-27 那条已恢复的授权超时（稿 6b）：种子里 23 通、持续 18 分钟的一条。 */
const alertDetailOpen = async (page: Page) => {
  await alertsOpen(page);
  const wide = (page.viewportSize()?.width ?? 0) >= 1100;
  const target = wide
    ? page
        .getByRole('row')
        .filter({ hasText: '授权超时' })
        .filter({ hasText: '已恢复' })
        .first()
        .getByRole('button')
        .first()
    : page
        .getByRole('button', { name: /授权超时/ })
        .filter({ hasText: '已恢复' })
        .first();
  await target.click();
  await expect(page.getByText('影响的通话', { exact: true })).toBeVisible();
};

const settingsOpen = async (page: Page) => {
  await page.goto('/admin/system-alerts');
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(page.getByText('告警接收邮箱', { exact: true })).toBeVisible();
};

const alertsEmpty = async (page: Page) => {
  await page.route('**/api/admin/system-alerts?*', (route) =>
    route.fulfill({
      json: {
        items: [],
        openCount: 0,
        pagination: { page: 1, pageSize: 50, total: 0 },
      },
    }),
  );
  await page.route('**/api/admin/system-alerts/summary', (route) =>
    route.fulfill({ json: { open: 0, last24h: 0, lastOpenedAt: null } }),
  );
  await page.goto('/admin/system-alerts');
  await expect(page.getByText('最近 30 天没有系统告警')).toBeVisible();
};

const portalAugust = async (page: Page) => {
  await page.goto('/portal/statements/2026-08');
  await expect(page.getByRole('heading', { name: '2026年8月' })).toBeVisible();
  await expect(page.getByRole('region', { name: '账单汇总' })).toBeVisible();
  await expect(page.getByRole('region', { name: '按国家汇总' })).toBeVisible();
};

test('matches the phase 9 overview, system alerts and statement frames in light and dark', async ({
  browser,
  page: admin,
  adminSession,
}) => {
  test.setTimeout(20 * 60_000);
  const search = await admin.request.get(
    '/api/admin/tenants?search=ABC001&pageSize=5',
  );
  const abc001 = (
    (await search.json()) as { items: { id: string; code: string }[] }
  ).items.find((tenant) => tenant.code === 'ABC001');
  if (!abc001) throw new Error('ABC001 not found');

  const shots: Shot<Session>[] = [];
  for (const width of widths) {
    const wideFrame = width.key !== '390';
    shots.push(
      {
        name: `overview-${width.key}`,
        session: 'admin',
        viewport: width.viewport,
        frame: wideFrame
          ? frame(
              operations,
              '概览 电脑',
              '1a 正常 · 有需要关注的事项（图表 CNY）',
            )
          : frame(
              operations,
              '概览 手机',
              '2a 手机 · 正常（指标 2 列，需要关注为卡片）',
            ),
        note: null,
        open: overviewOpen,
      },
      {
        name: `alerts-list-${width.key}`,
        session: 'admin',
        viewport: width.viewport,
        frame: wideFrame
          ? frame(
              operations,
              '系统告警',
              '6a 列表 · 含进行中和已恢复（菜单红点）',
            )
          : frame(operations, '系统告警', '6e 手机 · 列表'),
        note: null,
        open: alertsOpen,
      },
      {
        name: `alerts-detail-${width.key}`,
        session: 'admin',
        viewport: width.viewport,
        frame:
          width.key === '1440'
            ? frame(
                operations,
                '系统告警',
                '6b 告警详情 · 2026-09-27 03:08 授权超时',
              )
            : frame(operations, '系统告警', '6f 手机 · 告警详情（底部面板）'),
        note:
          width.key === '1440'
            ? null
            : '宽度不足 1100 时详情不在行内展开，改为底部面板（与手机同一个）。',
        open: alertDetailOpen,
        fullPage: width.key === '1440',
      },
      {
        name: `alerts-settings-${width.key}`,
        session: 'admin',
        viewport: width.viewport,
        frame: frame(operations, '系统告警', '6c 设置 · 接收邮箱与汇总间隔'),
        note: phone(width) ? '设计稿的设置页只有电脑画框。' : null,
        open: settingsOpen,
      },
      {
        name: `statement-august-${width.key}`,
        session: 'abc001',
        viewport: width.viewport,
        frame: wideFrame
          ? frame(portal, '月账单详情', '2c 电脑 · 已结束（2026年8月）')
          : frame(portal, '月账单详情', '2d 手机 · 已结束（2026年8月）'),
        note: '客户门户账单详情，#82 的算式对齐修复之后。',
        open: portalAugust,
      },
      {
        name: `admin-statement-august-${width.key}`,
        session: 'admin',
        viewport: width.viewport,
        frame: null,
        note: '后台租户账单详情没有设计稿（沿用门户版式），只存档，看 #82 对齐修复。',
        open: async (page) => {
          await page.goto(
            `/admin/tenants/${abc001.id}?tab=statements&statementMonth=2026-08`,
          );
          await expect(
            page.getByRole('region', { name: '按国家汇总' }),
          ).toBeVisible();
        },
      },
    );
  }
  shots.push(
    {
      name: 'overview-allclear-1440',
      session: 'admin',
      viewport: widths[0].viewport,
      frame: frame(
        operations,
        '概览 电脑',
        '1b 一切正常 · 没有需要关注的事项（图表切换为 USD）',
      ),
      note: '接口拦截：需要关注清空，图表切到 USD。',
      open: overviewAllClear,
    },
    {
      name: 'overview-allclear-390',
      session: 'admin',
      viewport: widths[3].viewport,
      frame: frame(operations, '概览 手机', '2b 手机 · 一切正常（图表 USD）'),
      note: '接口拦截：需要关注清空，图表切到 USD。',
      open: overviewAllClear,
    },
    {
      name: 'alerts-empty-1440',
      session: 'admin',
      viewport: widths[0].viewport,
      frame: frame(operations, '系统告警', '6d 没有告警（无红点）'),
      note: '接口拦截：列表与汇总清空。',
      open: alertsEmpty,
    },
  );

  const errors = await runShots<Session>(
    browser,
    shots,
    {
      admin: () => Promise.resolve(adminSession),
      abc001: (): Promise<StorageState> =>
        customerSession(browser, seededCustomer),
    },
    'index-phase9.json',
  );
  expect(errors).toEqual([]);
});
