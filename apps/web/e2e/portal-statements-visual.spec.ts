import { expect } from '@playwright/test';
import { test } from './admin';
import { openPortalCustomer } from './portal';
import { createTenant } from './admin';
import {
  customerSession,
  desktopViewport,
  narrowViewport,
  phoneViewport,
  runShots,
  seededCustomer,
  statementFixture,
  type Shot,
  type StorageState,
} from './statement-visual';
import type { DesignFrame } from '../scripts/screenshots/design-frames';

/**
 * 客户门户月账单与设计稿「客户门户 第二批」的逐张对照（列表 1a 至 1c、详情 2a 至 2d、
 * 话单明细已删除 3a 3b、空状态 4a 4b），各含浅色与深色。只在 FSB_VISUAL=1 时运行，
 * 输出到 FSB_EVIDENCE_DIR/visual（缺省 docs/evidence/phase-7-web），由人逐张查看 compare-*.png。
 */
test.skip(
  process.env['FSB_VISUAL'] !== '1',
  '视觉对照仅在 FSB_VISUAL=1 时运行',
);

const file = '客户门户 第二批.dc.html';
const frame = (section: string, label: string): DesignFrame => ({
  file,
  section,
  label,
});

type Session = 'abc001' | 'deleted' | 'empty';

/** 播种月就是运行时的北京月（同 portal-statements.spec.ts）。 */
const month = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 7);

const visibleText = (page: import('@playwright/test').Page, text: string) =>
  page.getByText(text).filter({ visible: true }).first();

const openList =
  (expected: string) => async (page: import('@playwright/test').Page) => {
    await page.goto('/portal/statements');
    await expect(
      page.getByRole('heading', { name: '月账单', level: 1 }),
    ).toBeVisible();
    await expect(visibleText(page, expected)).toBeVisible();
  };

const openDetail =
  (target: string, title: string) =>
  async (page: import('@playwright/test').Page) => {
    await page.goto(`/portal/statements/${target}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    await expect(page.getByRole('region', { name: '账单汇总' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: '按国家汇总' }),
    ).toBeVisible();
  };

const shots: Shot<Session>[] = [
  {
    name: 'statements-list-desktop',
    session: 'abc001',
    viewport: desktopViewport,
    frame: frame('月账单列表', '1a 电脑 · 全部列'),
    note: null,
    open: openList('2026年9月'),
  },
  {
    name: 'statements-list-1024',
    session: 'abc001',
    viewport: narrowViewport,
    frame: frame('月账单列表', '1b 窄屏 1024 · 精简列'),
    note: null,
    open: openList('2026年9月'),
  },
  {
    name: 'statements-list-phone',
    session: 'abc001',
    viewport: phoneViewport,
    frame: frame('月账单列表', '1c 手机'),
    note: null,
    open: openList('2026年9月'),
  },
  {
    name: 'statement-current-desktop',
    session: 'abc001',
    viewport: desktopViewport,
    frame: frame('月账单详情', '2a 电脑 · 本月（进行中）'),
    note: '播种月的进行中账单（20 通、81 分钟、¥3.51）。',
    open: async (page) => {
      await page.goto(`/portal/statements/${month}`);
      await expect(
        page.getByRole('heading', { name: /^\d{4}年\d{1,2}月$/ }),
      ).toBeVisible();
      await expect(page.getByText('本月（进行中）').first()).toBeVisible();
      await expect(
        page.getByRole('region', { name: '按国家汇总' }),
      ).toBeVisible();
    },
  },
  {
    name: 'statement-current-phone',
    session: 'abc001',
    viewport: phoneViewport,
    frame: frame('月账单详情', '2b 手机 · 本月（进行中）'),
    note: null,
    open: async (page) => {
      await page.goto(`/portal/statements/${month}`);
      await expect(visibleText(page, '本月尚未结束')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '按国家汇总' }),
      ).toBeVisible();
    },
  },
  {
    name: 'statement-august-desktop',
    session: 'abc001',
    viewport: desktopViewport,
    frame: frame('月账单详情', '2c 电脑 · 已结束（2026年8月）'),
    note: null,
    open: openDetail('2026-08', '2026年8月'),
  },
  {
    name: 'statement-august-phone',
    session: 'abc001',
    viewport: phoneViewport,
    frame: frame('月账单详情', '2d 手机 · 已结束（2026年8月）'),
    note: null,
    open: openDetail('2026-08', '2026年8月'),
  },
  {
    name: 'statement-september-desktop',
    session: 'abc001',
    viewport: desktopViewport,
    frame: null,
    note: '9 月（设计稿的列表有 9 月，详情只画了进行中与 8 月），只存档。',
    open: openDetail('2026-09', '2026年9月'),
  },
  {
    name: 'statement-deleted-desktop',
    session: 'deleted',
    viewport: desktopViewport,
    frame: frame('月账单详情', '3a 电脑 · 该月话单明细已删除'),
    note: '夹具租户，数据不是设计稿数字。',
    open: openDetail('2026-08', '2026年8月'),
  },
  {
    name: 'statement-deleted-phone',
    session: 'deleted',
    viewport: phoneViewport,
    frame: frame('月账单详情', '3b 手机 · 该月话单明细已删除'),
    note: '夹具租户，数据不是设计稿数字。',
    open: openDetail('2026-08', '2026年8月'),
  },
  {
    name: 'statements-empty-desktop',
    session: 'empty',
    viewport: desktopViewport,
    frame: frame('月账单空状态', '4a 电脑 · 空状态'),
    note: null,
    open: async (page) => {
      await page.goto('/portal/statements');
      await expect(
        page.getByRole('region', { name: '还没有账单' }),
      ).toBeVisible();
    },
  },
  {
    name: 'statements-empty-phone',
    session: 'empty',
    viewport: phoneViewport,
    frame: frame('月账单空状态', '4b 手机 · 空状态'),
    note: null,
    open: async (page) => {
      await page.goto('/portal/statements');
      await expect(
        page.getByRole('region', { name: '还没有账单' }),
      ).toBeVisible();
    },
  },
];

test('matches portal statement frames in light and dark', async ({
  browser,
  page: admin,
}) => {
  test.setTimeout(15 * 60_000);
  const portalState = async (tenant: {
    id: string;
    code: string;
  }): Promise<StorageState> => {
    const customer = await openPortalCustomer(admin, browser, tenant);
    const state = await customer.context.storageState();
    await customer.context.close();
    return state;
  };
  const errors = await runShots<Session>(
    browser,
    shots,
    {
      abc001: () => customerSession(browser, seededCustomer),
      deleted: async () =>
        portalState(await statementFixture(admin, { deleteAugust: true })),
      empty: async () => portalState(await createTenant(admin)),
    },
    'index-portal.json',
  );
  expect(errors).toEqual([]);
});
