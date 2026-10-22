import { expect, type Page } from '@playwright/test';
import type { DesignFrame } from '../scripts/screenshots/design-frames';
import { test } from './admin';
import {
  desktopViewport,
  phoneViewport,
  runShots,
  statementFixture,
  type Shot,
} from './statement-visual';

/**
 * 管理后台账单页（运营稿 5a 至 5c）与租户详情账单标签页（租户详情稿 1f、1g、3f、3g）
 * 与设计稿的逐张对照，各含浅色与深色。只在 FSB_VISUAL=1 时运行，
 * 输出到 FSB_EVIDENCE_DIR/visual（缺省 docs/evidence/phase-7-web），由人逐张查看 compare-*.png。
 * 重新生成对话框只打开，不提交，不改 ABC001。
 */
test.skip(
  process.env['FSB_VISUAL'] !== '1',
  '视觉对照仅在 FSB_VISUAL=1 时运行',
);

const operations = '管理后台 第三批 · 运营.dc.html';
const detail = '管理后台 第三批 · 租户详情.dc.html';
const frame = (file: string, section: string, label: string): DesignFrame => ({
  file,
  section,
  label,
});

const visibleText = (page: Page, text: string) =>
  page.getByText(text).filter({ visible: true }).first();

test('matches admin statement frames in light and dark', async ({
  browser,
  page: admin,
  adminSession,
}) => {
  test.setTimeout(15 * 60_000);
  const search = await admin.request.get(
    '/api/admin/tenants?search=ABC001&pageSize=5',
  );
  const abc001 = (
    (await search.json()) as { items: { id: string; code: string }[] }
  ).items.find((tenant) => tenant.code === 'ABC001');
  if (!abc001) throw new Error('ABC001 not found');
  const deleted = await statementFixture(admin, { deleteAugust: true });

  const openStatements = (query: string, expected: string) =>
    async function open(page: Page) {
      await page.goto(`/admin/statements${query}`);
      await expect(
        page.getByRole('heading', { name: '账单', level: 1 }),
      ).toBeVisible();
      await expect(visibleText(page, expected)).toBeVisible();
    };
  const openTab = (id: string, expected: string) =>
    async function open(page: Page) {
      await page.goto(`/admin/tenants/${id}?tab=statements`);
      await expect(visibleText(page, expected)).toBeVisible();
    };

  const shots: Shot<'admin'>[] = [
    {
      name: 'statements-default-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: frame(
        operations,
        '账单',
        '5a 电脑 · 2026年8月（默认上月）· HZX014 话单已删除，不可重新生成',
      ),
      note: '默认上月是 2026-09（稿中是 8 月）；对照稿 5a 的版式。',
      open: openStatements('', 'ABC001'),
    },
    {
      name: 'statements-august-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: frame(
        operations,
        '账单',
        '5a 电脑 · 2026年8月（默认上月）· HZX014 话单已删除，不可重新生成',
      ),
      note: '2026-08：ABC001 加一个话单已删除的夹具租户（稿中是 HZX014）。',
      open: openStatements('?month=2026-08', deleted.code),
    },
    {
      name: 'statements-regenerate-dialog',
      session: 'admin',
      viewport: desktopViewport,
      frame: frame(operations, '账单', '5b 电脑 · 重新生成确认'),
      note: '只打开对话框，不提交。',
      fullPage: false,
      open: async (page) => {
        await openStatements('?month=2026-08', 'ABC001')(page);
        await page
          .getByRole('button', { name: '重新生成 ABC001 2026年8月' })
          .click();
        await expect(
          page.getByRole('dialog', { name: /^重新生成 ABC001 .+ 账单？$/ }),
        ).toBeVisible();
      },
    },
    {
      name: 'statements-default-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: frame(operations, '账单', '5c 手机'),
      note: '稿中「手机端仅显示前 3 个租户示意」，实现显示全部租户。',
      open: openStatements('', 'ABC001'),
    },
    {
      name: 'tenant-statements-abc001-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: frame(detail, '租户详情 电脑', '1f 账单 · 本月进行中不可重新生成'),
      note: null,
      open: openTab(abc001.id, '2026年9月'),
    },
    {
      name: 'tenant-statements-abc001-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: frame(detail, '租户详情 手机', '3f 账单'),
      note: null,
      open: openTab(abc001.id, '2026年9月'),
    },
    {
      name: 'tenant-statements-deleted-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: frame(
        detail,
        '租户详情 电脑',
        '1g 账单 · 该月话单已删除，不可重新生成',
      ),
      note: '夹具租户，数据不是设计稿数字。',
      open: openTab(deleted.id, '2026年8月'),
    },
    {
      name: 'tenant-statements-deleted-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: frame(detail, '租户详情 手机', '3g 账单 · 话单已删除'),
      note: '夹具租户，数据不是设计稿数字。',
      open: openTab(deleted.id, '2026年8月'),
    },
    {
      name: 'tenant-statement-abc001-august-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: null,
      note: '后台账单详情没有设计稿（决定：沿用门户第二批版式加管理员信息块），只存档。',
      open: async (page) => {
        await page.goto(
          `/admin/tenants/${abc001.id}?tab=statements&statementMonth=2026-08`,
        );
        await expect(
          page.getByRole('region', { name: '按国家汇总' }),
        ).toBeVisible();
      },
    },
    {
      name: 'tenant-statement-abc001-august-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: null,
      note: '后台账单详情没有设计稿，只存档。',
      open: async (page) => {
        await page.goto(
          `/admin/tenants/${abc001.id}?tab=statements&statementMonth=2026-08`,
        );
        await expect(
          page.getByRole('region', { name: '按国家汇总' }),
        ).toBeVisible();
      },
    },
  ];

  const errors = await runShots<'admin'>(
    browser,
    shots,
    { admin: () => Promise.resolve(adminSession) },
    'index-admin.json',
  );
  expect(errors).toEqual([]);
});
