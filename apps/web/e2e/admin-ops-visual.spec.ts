import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';
import type { DesignFrame } from '../scripts/screenshots/design-frames';
import { accounts } from './accounts';
import { createTenant, test } from './admin';
import {
  backdateTenant,
  recordLedgerEntry,
  recordStatementCall,
  setStatementFlags,
} from './db';
import { repoRoot } from './env';
import {
  assignableTenant,
  assignRowsAssignable,
  assignRowsCharge,
} from './ops';
import {
  desktopViewport,
  phoneViewport,
  runShots,
  type Shot,
} from './statement-visual';

/**
 * 阶段 8 管理后台话单运维页面与设计稿的逐张对照，各含浅色与深色（决定 6 的做法，沿用阶段 6、7）：
 * 运营稿 3a 至 3h（未归属话单电脑）、4a 至 4c（手机）、7a 至 7d（操作日志），
 * 租户详情稿「删除话单对话框」4a 至 4h。只在 FSB_VISUAL=1 时运行，
 * 输出到 FSB_EVIDENCE_DIR/visual（缺省 docs/evidence/phase-8-web），由人逐张查看 compare-*.png。
 *
 * 不改种子数据：分配对话框只预览、不提交；会写入的画面（分配完成、删除完成）每次都在新建的夹具租户上做，
 * 浅色与深色两轮互不影响。
 */
process.env['FSB_EVIDENCE_DIR'] ??= join(repoRoot, 'docs/evidence/phase-8-web');

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
const unassignedDesktop = (label: string) =>
  frame(operations, '未归属话单 电脑', label);
const unassignedPhone = (label: string) =>
  frame(operations, '未归属话单 手机', label);
const auditLog = (label: string) => frame(operations, '操作日志', label);
const deleteDialog = (label: string) => frame(detail, '删除话单对话框', label);

const table = (page: Page) => page.getByRole('table');
const rowCheckboxes = (page: Page) =>
  page.getByRole('checkbox').filter({ hasNot: page.getByText('选择本页') });

/** 8 月初开户、8 月有 3 通已接通电话（账单已生成、核对通过），9 月没有账单：9 月格不可选，与稿 4a 一致。 */
async function augustTenant(page: Page, options: { deleted?: boolean } = {}) {
  const tenant = await createTenant(page);
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
  const generated = await page.request.post(
    `/api/admin/tenants/${tenant.id}/statements/2026-08/regenerate`,
    { data: { expectedVersion: 0 } },
  );
  expect(generated.status()).toBe(200);
  await setStatementFlags(tenant.id, '2026-08', { reconcileStatus: 'ok' });
  if (options.deleted) {
    const deleted = await page.request.post(
      `/api/admin/tenants/${tenant.id}/cdr-deletions`,
      {
        data: {
          fromMonth: '2026-08',
          toMonth: '2026-08',
          tenantCode: tenant.code,
          expectedCount: 3,
        },
      },
    );
    expect(deleted.status()).toBe(200);
  }
  return tenant;
}

async function showYear(dialog: ReturnType<Page['locator']>, year: number) {
  for (let guard = 0; guard < 10; guard += 1) {
    const shown = Number(
      (
        await dialog
          .getByText(/^\d{4}年$/)
          .first()
          .textContent()
      )?.slice(0, 4),
    );
    if (shown === year) return;
    await dialog
      .getByRole('button', { name: shown > year ? '上一年' : '下一年' })
      .click();
  }
  throw new Error(`could not show ${year}`);
}

/** 打开租户话单标签页（8 月）与删除话单对话框，展开开始月份的格子并翻到 2026 年。 */
async function openDeleteDialog(page: Page, tenantId: string) {
  await page.goto(
    `/admin/tenants/${tenantId}?tab=cdrs&cdrFrom=2026-08-01&cdrTo=2026-08-31`,
  );
  await page.getByRole('button', { name: '删除话单' }).first().click();
  const dialog = page.getByRole('dialog', { name: '删除话单' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function pickAugust(page: Page, tenantId: string) {
  const dialog = await openDeleteDialog(page, tenantId);
  // 打开即预选最近一个可删除的月份（8 月），预览立刻显示（稿 4b、4g）。
  await expect(
    dialog.getByRole('button', { name: '开始月份：2026年8月' }),
  ).toBeVisible();
  await expect(dialog).toContainText('将删除');
  return dialog;
}

/** 点开租户下拉（单行，稿 3d、3e、4b），可选再选一个租户；列表挂在对话框之外。 */
async function openTenantPicker(
  page: Page,
  dialog: ReturnType<Page['locator']>,
) {
  await dialog.getByRole('combobox', { name: /^归属到租户/ }).click();
  await expect(page.getByRole('option').first()).toBeVisible();
}

async function pickTenant(
  page: Page,
  dialog: ReturnType<Page['locator']>,
  name: RegExp,
) {
  await openTenantPicker(page, dialog);
  await page.getByRole('option', { name }).click();
}

async function openAssignDialog(page: Page) {
  await page
    .getByRole('button', { name: '选择「标签 ABC01」全部 326 条' })
    .click();
  await page.getByRole('button', { name: '归属到租户' }).click();
  const dialog = page.getByRole('dialog', { name: '归属到租户' });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function openIgnoreDialog(page: Page) {
  await page.goto('/admin/unassigned?tag=ABC01');
  await expect(table(page)).toBeVisible();
  const boxes = page.getByRole('checkbox', { name: /^选择 \d+ 呼 / });
  for (const index of [0, 1, 2]) await boxes.nth(index).check();
  await page.getByRole('button', { name: '忽略', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '忽略 3 条话单' });
  await expect(dialog).toBeVisible();
  // 稿 3f / 4c：未填原因就提交，显示必填提示。
  await dialog.getByRole('button', { name: '忽略 3 条' }).click();
  await expect(dialog.getByText('请填写忽略原因')).toBeVisible();
  return dialog;
}

test('matches admin operations frames in light and dark', async ({
  browser,
  page: admin,
  adminSession,
}) => {
  test.setTimeout(30 * 60_000);

  // 操作日志里要有删除话单与归属话单两条（用夹具租户，通过接口产生，不动种子）。
  await augustTenant(admin, { deleted: true });
  const assigned = await assignableTenant(admin, { noRate: false });
  const assignResponse = await admin.request.post(
    '/api/admin/unassigned-cdrs/assign',
    {
      data: {
        tenantId: assigned.id,
        selection: { group: { tag: assigned.tag } },
        idempotencyKey: `visual:${assigned.code}`,
        expected: {
          assignable: assignRowsAssignable,
          noRate: 0,
          chargeTotal: assignRowsCharge,
        },
      },
    },
  );
  expect(assignResponse.status()).toBe(200);

  const shots: Shot<'admin'>[] = [
    {
      name: 'unassigned-list-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3a 列表 · 全部分组'),
      note: null,
      open: async (page) => {
        await page.goto('/admin/unassigned');
        await expect(table(page)).toBeVisible();
        await expect(
          page.getByRole('button', { name: /标签 ABC01/ }),
        ).toBeVisible();
      },
    },
    {
      name: 'unassigned-group-checked-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3b 点击分组筛选「ABC01」· 勾选 3 条'),
      note: null,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(table(page)).toBeVisible();
        const boxes = page.getByRole('checkbox', { name: /^选择 \d+ 呼 / });
        for (const index of [0, 1, 2]) await boxes.nth(index).check();
        await expect(
          page.getByText('已选 3 条', { exact: true }),
        ).toBeVisible();
      },
    },
    {
      name: 'unassigned-group-all-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3c 已选择该分组全部 326 条'),
      note: null,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(table(page)).toBeVisible();
        await page
          .getByRole('button', { name: '选择「标签 ABC01」全部 326 条' })
          .click();
        await expect(
          page.getByText('已选择「标签 ABC01」全部 326 条'),
        ).toBeVisible();
      },
    },
    {
      name: 'unassigned-assign-pick-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3d 归属到租户 · 选择租户'),
      note: null,
      fullPage: false,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(table(page)).toBeVisible();
        const dialog = await openAssignDialog(page);
        await openTenantPicker(page, dialog);
      },
    },
    {
      name: 'unassigned-assign-preview-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3e 归属到租户 · 预览（2 条匹配不到费率）'),
      note: '只预览，不提交。',
      fullPage: false,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(table(page)).toBeVisible();
        const dialog = await openAssignDialog(page);
        await pickTenant(page, dialog, /ABC001/);
        await expect(dialog).toContainText('扣费合计¥58.35');
      },
    },
    {
      name: 'unassigned-ignore-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3f 忽略 · 原因必填（未填写时提交）'),
      note: '只打开并空提交，不忽略。',
      fullPage: false,
      open: async (page) => {
        await openIgnoreDialog(page);
      },
    },
    {
      name: 'unassigned-ignored-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3g 已忽略标签页'),
      note: null,
      open: async (page) => {
        await page.goto('/admin/unassigned?tab=ignored');
        await expect(table(page)).toBeVisible();
        await expect(
          page.getByRole('button', { name: '撤销忽略' }).first(),
        ).toBeVisible();
      },
    },
    {
      name: 'unassigned-empty-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: unassignedDesktop('3h 没有未归属话单'),
      note: '种子里有 338 条待处理，这一状态用接口拦截（summary、groups、list 返回空）渲染，不改库。',
      open: async (page) => {
        await page.route('**/api/admin/unassigned-cdrs/**', (route) => {
          const path = new URL(route.request().url()).pathname;
          const body = path.endsWith('/summary')
            ? { pending: 0, ignored: 5 }
            : path.endsWith('/groups')
              ? { total: 0, groups: [] }
              : {
                  status: 'pending',
                  items: [],
                  pagination: { page: 1, pageSize: 50, total: 0 },
                };
          return route.fulfill({ json: body });
        });
        await page.route('**/api/admin/unassigned-cdrs', (route) =>
          route.fulfill({
            json: {
              status: 'pending',
              items: [],
              pagination: { page: 1, pageSize: 50, total: 0 },
            },
          }),
        );
        await page.goto('/admin/unassigned');
        await expect(page.getByText('所有话单都已归属')).toBeVisible();
      },
    },
    {
      name: 'unassigned-list-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: unassignedPhone('4a 手机 · 列表（分组 + 勾选）'),
      note: '截一屏视口：操作栏固定在底部（整页截图会把固定的操作栏放在页面中段）。',
      fullPage: false,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(page.getByRole('article').first()).toBeVisible();
        const boxes = page.getByRole('checkbox', { name: /^选择 \d+ 呼 / });
        for (const index of [0, 1]) await boxes.nth(index).check();
        await expect(
          page.getByText('已选 2 条', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('region', { name: '批量操作' }),
        ).toBeVisible();
        // 勾选时页面滚到了列表中段；回到顶部，和稿 4a 一样从提示条与分组开始。
        await page.evaluate(() => window.scrollTo(0, 0));
      },
    },
    {
      name: 'unassigned-assign-preview-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: unassignedPhone('4b 手机 · 归属预览（底部面板）'),
      note: '只预览，不提交。',
      fullPage: false,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(page.getByRole('article').first()).toBeVisible();
        const dialog = await openAssignDialog(page);
        await pickTenant(page, dialog, /ABC001/);
        await expect(dialog).toContainText('扣费合计¥58.35');
      },
    },
    {
      name: 'unassigned-ignore-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: unassignedPhone('4c 手机 · 忽略（原因必填）'),
      note: '只打开并空提交，不忽略。',
      fullPage: false,
      open: async (page) => {
        await page.goto('/admin/unassigned?tag=ABC01');
        await expect(page.getByRole('article').first()).toBeVisible();
        const boxes = page.getByRole('checkbox', { name: /^选择 \d+ 呼 / });
        for (const index of [0, 1, 2]) await boxes.nth(index).check();
        await page.getByRole('button', { name: '忽略', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '忽略 3 条话单' });
        await dialog.getByRole('button', { name: '忽略 3 条' }).click();
        await expect(dialog.getByText('请填写忽略原因')).toBeVisible();
      },
    },
    {
      name: 'unassigned-assign-done-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: null,
      note: '稿中没有归属完成画面，只存档。夹具租户（每次新建），不是 ABC001。',
      fullPage: false,
      open: async (page) => {
        const tenant = await assignableTenant(page, { noRate: false });
        await page.goto(`/admin/unassigned?tag=${tenant.tag}`);
        await page.getByRole('checkbox', { name: '选择本页' }).check();
        await page.getByRole('button', { name: '归属到租户' }).click();
        const dialog = page.getByRole('dialog', { name: '归属到租户' });
        await pickTenant(page, dialog, new RegExp(tenant.code));
        await dialog
          .getByRole('button', {
            name: `确认归属 ${assignRowsAssignable} 条并扣费`,
          })
          .click();
        await expect(
          dialog.getByRole('heading', { name: '归属完成' }),
        ).toBeVisible();
      },
    },
    {
      name: 'unassigned-assign-done-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: null,
      note: '稿中没有归属完成画面，只存档。夹具租户。',
      fullPage: false,
      open: async (page) => {
        const tenant = await assignableTenant(page, { noRate: false });
        await page.goto(`/admin/unassigned?tag=${tenant.tag}`);
        await page
          .getByRole('checkbox', { name: /^选择 \d+ 呼 / })
          .first()
          .check();
        await page
          .getByRole('checkbox', { name: /^选择 \d+ 呼 / })
          .nth(1)
          .check();
        await page
          .getByRole('checkbox', { name: /^选择 \d+ 呼 / })
          .nth(2)
          .check();
        await page.getByRole('button', { name: '归属到租户' }).click();
        const dialog = page.getByRole('dialog', { name: '归属到租户' });
        await pickTenant(page, dialog, new RegExp(tenant.code));
        await dialog
          .getByRole('button', {
            name: `确认归属 ${assignRowsAssignable} 条并扣费`,
          })
          .click();
        await expect(
          dialog.getByRole('heading', { name: '归属完成' }),
        ).toBeVisible();
      },
    },
    {
      name: 'audit-logs-list-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: auditLog('7a 列表'),
      note: '稿的 214 条是示例；实现是种子加本轮夹具产生的记录。',
      open: async (page) => {
        await page.goto('/admin/audit-logs');
        await expect(
          page.getByRole('table', { name: '操作记录' }),
        ).toBeVisible();
      },
    },
    {
      name: 'audit-logs-expanded-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: auditLog('7b 展开详情 · 修改费率、确认收款'),
      note: '稿展开的是修改费率与确认收款；实现展开最近的两条（删除话单、归属话单）。',
      open: async (page) => {
        await page.goto('/admin/audit-logs');
        const rows = page
          .getByRole('table', { name: '操作记录' })
          .locator('tbody > tr[tabindex]');
        await expect(rows.first()).toBeVisible();
        await rows.nth(0).click();
        await rows.nth(1).click();
        await expect(
          page.getByRole('table', { name: '修改前后' }).first(),
        ).toBeVisible();
      },
    },
    {
      name: 'audit-logs-empty-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: auditLog('7c 筛选结果为空'),
      note: null,
      open: async (page) => {
        await page.goto('/admin/audit-logs?label=cdr_delete');
        await expect(
          page.getByRole('table', { name: '操作记录' }),
        ).toBeVisible();
        await page
          .getByRole('combobox', { name: '管理员' })
          .selectOption({ label: '李俊' });
        await expect(page.getByText('没有符合条件的操作记录')).toBeVisible();
      },
    },
    {
      name: 'audit-logs-list-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: auditLog('7d 手机 · 列表（点击卡片展开）'),
      note: null,
      open: async (page) => {
        await page.goto('/admin/audit-logs');
        const cards = page.getByRole('button', { expanded: false }).filter({
          hasText: /删除话单|归属话单/,
        });
        await expect(cards.first()).toBeVisible();
        await cards.first().click();
      },
    },
    {
      name: 'cdr-delete-pick-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: deleteDialog('4a 选择月份 · 月份选择器展开（9月不可选）'),
      note: '夹具租户：8 月有 3 条话单、账单已生成，9 月没有账单（不可选，与稿一致）。当月（运行日所在月）同样置灰，格子下方写明原因。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await openDeleteDialog(page, tenant.id);
        await dialog
          .getByRole('button', { name: '开始月份：2026年8月' })
          .click();
        await showYear(dialog, 2026);
        await expect(
          dialog.getByRole('button', { name: /^2026年8月，/ }),
        ).toBeEnabled();
        await expect(dialog.getByTestId('month-reasons')).toBeVisible();
      },
    },
    {
      name: 'cdr-delete-preview-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: deleteDialog('4b 预览与影响说明 · 未输入编码，删除不可用'),
      note: '夹具租户，数字不是稿中的 9,642 条。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        await pickAugust(page, tenant.id);
      },
    },
    {
      name: 'cdr-delete-wrong-code-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: deleteDialog('4c 编码输入错误（ABC01）· 仍不可用'),
      note: '稿输入的是标签 ABC01；实现输入夹具租户编码的小写形式。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await pickAugust(page, tenant.id);
        await dialog
          .getByRole('textbox', { name: /请输入租户编码/ })
          .fill(tenant.code.toLowerCase());
        await expect(
          dialog.getByText('编码不一致', { exact: false }),
        ).toBeVisible();
      },
    },
    {
      name: 'cdr-delete-ready-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: deleteDialog('4d 编码正确 · 删除按钮可用'),
      note: '只填编码，不提交。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await pickAugust(page, tenant.id);
        await dialog
          .getByRole('textbox', { name: /请输入租户编码/ })
          .fill(tenant.code);
        await expect(dialog.getByText('✓ 编码正确')).toBeVisible();
      },
    },
    {
      name: 'cdr-delete-done-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: deleteDialog('4e 删除完成'),
      note: '夹具租户上真实删除。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await pickAugust(page, tenant.id);
        await dialog
          .getByRole('textbox', { name: /请输入租户编码/ })
          .fill(tenant.code);
        await dialog.getByRole('button', { name: '删除 3 条话单' }).click();
        await expect(
          dialog.getByRole('heading', { name: '已删除 3 条话单' }),
        ).toBeVisible();
      },
    },
    {
      name: 'cdr-delete-pick-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: deleteDialog('4f 手机 · 选择月份（底部面板）'),
      note: null,
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await openDeleteDialog(page, tenant.id);
        await dialog
          .getByRole('button', { name: '开始月份：2026年8月' })
          .click();
        // 手机：单独的「选择开始月份」底部面板，带不可选原因和「确定」。
        const sheet = page.getByRole('dialog', { name: '选择开始月份' });
        await showYear(sheet, 2026);
        await expect(
          sheet.getByRole('button', { name: /^2026年8月，/ }),
        ).toBeEnabled();
        await expect(sheet.getByTestId('month-reasons')).toBeVisible();
        await expect(sheet.getByRole('button', { name: '确定' })).toBeVisible();
      },
    },
    {
      name: 'cdr-delete-ready-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: deleteDialog('4g 手机 · 编码正确，可删除'),
      note: '只填编码，不提交。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await pickAugust(page, tenant.id);
        await dialog
          .getByRole('textbox', { name: /请输入租户编码/ })
          .fill(tenant.code);
        await expect(dialog.getByText('✓ 编码正确')).toBeVisible();
      },
    },
    {
      name: 'cdr-delete-done-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: deleteDialog('4h 手机 · 删除完成'),
      note: '夹具租户上真实删除。',
      fullPage: false,
      open: async (page) => {
        const tenant = await augustTenant(page);
        const dialog = await pickAugust(page, tenant.id);
        await dialog
          .getByRole('textbox', { name: /请输入租户编码/ })
          .fill(tenant.code);
        await dialog.getByRole('button', { name: '删除 3 条话单' }).click();
        await expect(
          dialog.getByRole('heading', { name: '已删除 3 条话单' }),
        ).toBeVisible();
      },
    },
    {
      name: 'tenant-cdrs-deleted-desktop',
      session: 'admin',
      viewport: desktopViewport,
      frame: null,
      note: '租户详情话单标签页的已删除月份提示条与「删除话单」按钮；删除话单原型没有对应的静态画框，只存档。',
      open: async (page) => {
        const tenant = await augustTenant(page, { deleted: true });
        await page.goto(
          `/admin/tenants/${tenant.id}?tab=cdrs&cdrFrom=2026-08-01&cdrTo=2026-08-31`,
        );
        await expect(
          page.getByRole('region', { name: '已删除的话单' }),
        ).toBeVisible();
      },
    },
    {
      name: 'tenant-cdrs-deleted-phone',
      session: 'admin',
      viewport: phoneViewport,
      frame: null,
      note: '同上，手机。',
      open: async (page) => {
        const tenant = await augustTenant(page, { deleted: true });
        await page.goto(
          `/admin/tenants/${tenant.id}?tab=cdrs&cdrFrom=2026-08-01&cdrTo=2026-08-31`,
        );
        await expect(
          page.getByRole('region', { name: '已删除的话单' }),
        ).toBeVisible();
      },
    },
  ];

  const errors = await runShots<'admin'>(
    browser,
    shots,
    { admin: () => Promise.resolve(adminSession) },
    'index-admin-ops.json',
  );
  expect(errors).toEqual([]);
  void rowCheckboxes;
});
