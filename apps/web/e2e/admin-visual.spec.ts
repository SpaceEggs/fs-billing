import { randomUUID } from 'node:crypto';
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
import { test, uniqueCode } from './admin';
import { accounts } from './accounts';
import { recordCalls, recordPastCredit } from './db';
import { webOrigin } from './env';
import { expectPath, submitLogin } from './helpers';

/**
 * 管理后台各页面浅色、深色、手机与种子稿逐页对照截图。只在 FSB_VISUAL=1 时运行，
 * 输出到 FSB_EVIDENCE_DIR/visual（不写入仓库），由人逐张查看 compare-*.png。
 */
test.skip(
  process.env['FSB_VISUAL'] !== '1',
  '视觉对照仅在 FSB_VISUAL=1 时运行',
);

type Variant = 'light' | 'dark' | 'mobile';
const variants: Variant[] = ['light', 'dark', 'mobile'];
const mobileViewport = { width: 375, height: 812 };
const pageViewport = { width: 1440, height: 900 };
// 对话框画框宽 760–860，窄于 md 断点（768）时实现会切成底部面板，故统一放宽到 1024。
const dialogViewport = { width: 1024, height: 800 };

const batch1 = '管理后台 第一批.dc.html';
const batch2 = '管理后台 第二批.dc.html';
const detail3 = '管理后台 第三批 · 租户详情.dc.html';
const system3 = '管理后台 第三批 · 系统与账号.dc.html';
const portal3 = '客户门户 第三批.dc.html';
const frame = (file: string, section: string, label: string): DesignFrame => ({
  file,
  section,
  label,
});

const rates = [
  { iso: '', description: '', prefix: '86', country: '中国', rate: '0.0500' },
  {
    iso: '',
    description: '',
    prefix: '1',
    country: '美国/加拿大',
    rate: '0.0100',
  },
  {
    iso: '',
    description: '',
    prefix: '447',
    country: '英国手机',
    rate: '0.0450',
  },
  { iso: '', description: '', prefix: '44', country: '英国', rate: '0.0200' },
  { iso: '', description: '', prefix: '65', country: '新加坡', rate: '0.0280' },
  { iso: '', description: '', prefix: '81', country: '日本', rate: '0.0350' },
  {
    iso: '',
    description: '',
    prefix: '852',
    country: '中国香港',
    rate: '0.0300',
  },
  {
    iso: '',
    description: '',
    prefix: '1876',
    country: '牙买加',
    rate: '0.2500',
  },
];

type Tenant = { id: string; code: string };
type Seed = {
  run: string;
  cny: Tenant;
  usd: Tenant;
  source: Tenant;
  target: Tenant;
  admin: { name: string; email: string };
  forced: { email: string; password: string };
};

async function post<T>(page: Page, path: string, data: unknown) {
  const response = await page.request.post(path, { data });
  expect(response.status(), `${path} ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

function beijingDate(daysAhead = 0) {
  return new Date(Date.now() + (8 + daysAhead * 24) * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

async function seedTenant(
  page: Page,
  options: {
    code: string;
    name: string;
    currency: 'CNY' | 'USD';
    overdraftLimit: string;
    lowBalanceThreshold: string;
    rates: typeof rates;
  },
) {
  const body = await post<{ tenant: { id: string } }>(
    page,
    '/api/admin/tenants',
    {
      code: options.code,
      name: options.name,
      currency: options.currency,
      contactName: '张经理',
      contactPhone: '0755-86001234',
      settings: {
        overdraftLimit: options.overdraftLimit,
        lowBalanceThreshold: options.lowBalanceThreshold,
        emails: [`billing@${options.code.toLowerCase()}.example.com`],
      },
      initialRates: { kind: 'entries', entries: options.rates },
    },
  );
  return { id: body.tenant.id, code: options.code };
}

async function balanceOperation(
  page: Page,
  tenant: Tenant,
  currency: 'CNY' | 'USD',
  operation:
    | { kind: 'topup' | 'gift'; amount: string; note: string }
    | { kind: 'credit_topup'; amount: string; internalNote: string }
    | { kind: 'adjustment'; amount: string; reason: string },
) {
  const body = await post<{ entry: { id: string } }>(
    page,
    `/api/admin/tenants/${tenant.id}/balance-operations`,
    { ...operation, currency, idempotencyKey: randomUUID() },
  );
  return body.entry.id;
}

/**
 * 经真实接口种下各页面所需状态：CNY 透支中（有话单、调账、排定版本、门户账号）、
 * USD 余额偏低，待收款 / 已收款 / 已作废各至少一笔，另建两位管理员。
 */
async function seed(page: Page): Promise<Seed> {
  const run = uniqueCode('VIS');
  const cny = await seedTenant(page, {
    code: `${run}A`,
    name: '深圳市某某科技有限公司',
    currency: 'CNY',
    overdraftLimit: '100',
    lowBalanceThreshold: '200',
    rates,
  });
  const usd = await seedTenant(page, {
    code: `${run}U`,
    name: 'Global Voice Ltd',
    currency: 'USD',
    overdraftLimit: '0',
    lowBalanceThreshold: '500',
    rates: rates.slice(0, 4),
  });
  const source = await seedTenant(page, {
    code: `${run}S`,
    name: '广州某某通信有限公司',
    currency: 'CNY',
    overdraftLimit: '0',
    lowBalanceThreshold: '200',
    rates,
  });
  const target = await seedTenant(page, {
    code: `${run}T`,
    name: '杭州某某网络有限公司',
    currency: 'CNY',
    overdraftLimit: '0',
    lowBalanceThreshold: '200',
    rates: [
      {
        iso: '',
        description: '',
        prefix: '86',
        country: '中国',
        rate: '0.0400',
      },
      {
        iso: '',
        description: '',
        prefix: '64',
        country: '新西兰',
        rate: '0.2000',
      },
    ],
  });

  await balanceOperation(page, cny, 'CNY', {
    kind: 'topup',
    amount: '3000',
    note: '对公转账',
  });
  await balanceOperation(page, cny, 'CNY', {
    kind: 'gift',
    amount: '50',
    note: '新客户赠送',
  });
  await balanceOperation(page, cny, 'CNY', {
    kind: 'credit_topup',
    amount: '1300',
    internalNote: '月底付款',
  });
  const received = await balanceOperation(page, cny, 'CNY', {
    kind: 'credit_topup',
    amount: '500',
    internalNote: '已约定付款日',
  });
  const voided = await balanceOperation(page, cny, 'CNY', {
    kind: 'credit_topup',
    amount: '200',
    internalNote: '合同待签',
  });
  const reversal = await balanceOperation(page, cny, 'CNY', {
    kind: 'adjustment',
    amount: '-200',
    reason: '合同终止，冲正赊账',
  });
  await balanceOperation(page, cny, 'CNY', {
    kind: 'adjustment',
    amount: '-25.5',
    reason: '话费争议',
  });
  await post(page, `/api/admin/receivables/${received}/confirm-payment`, {
    expectedLatestSettlementId: null,
    receivedOn: beijingDate(),
    note: '工行对公转账',
  });
  await post(page, `/api/admin/receivables/${voided}/void`, {
    adjustmentLedgerEntryId: reversal,
    reason: '客户合同终止',
  });
  // 已欠 42 天的待收款，展示逾期高亮（决定 10，同稿 6a GZT007）。记在目标租户，不改变 CNY 租户的余额。
  await recordPastCredit(target.id, {
    amount: '2000',
    note: '季度结算',
    daysAgo: 42,
    adminEmail: accounts.admin,
  });
  // 4824.50 入账 − 4859.70 通话扣费 = −35.20，透支额度 100 → 可用 64.80（同稿 2a）。
  await recordCalls(cny.id, { charge: '4859.70', minutes: '97' });

  const ratesBody = (await (
    await page.request.get(`/api/admin/tenants/${cny.id}/rates`)
  ).json()) as { current: { id: string } };
  await post(page, `/api/admin/tenants/${cny.id}/rates/edit-entry`, {
    baseVersionId: ratesBody.current.id,
    entry: {
      iso: '',
      description: '',
      prefix: '447',
      country: '英国手机',
      rate: '0.0480',
    },
    schedule: {
      kind: 'scheduled',
      effectiveFrom: `${beijingDate(2)}T09:00:00+08:00`,
    },
  });
  await post(page, `/api/admin/tenants/${cny.id}/portal-accounts`, {
    email: `${cny.code.toLowerCase()}@example.com`,
  });

  await balanceOperation(page, usd, 'USD', {
    kind: 'topup',
    amount: '120',
    note: 'Wire transfer',
  });
  await balanceOperation(page, usd, 'USD', {
    kind: 'credit_topup',
    amount: '300',
    internalNote: 'Net 30',
  });

  const admin = {
    name: '张伟',
    email: `${run.toLowerCase()}-admin@example.com`,
  };
  await post(page, '/api/admin/admins', admin);
  const forcedEmail = `${run.toLowerCase()}-forced@example.com`;
  const forced = await post<{ temporaryPassword: string }>(
    page,
    '/api/admin/admins',
    { name: '陈静', email: forcedEmail },
  );
  return {
    run,
    cny,
    usd,
    source,
    target,
    admin,
    forced: { email: forcedEmail, password: forced.temporaryPassword },
  };
}

/** 电脑表格与手机卡片同时渲染（各自用 CSS 隐藏），只取可见的那份。 */
function visibleText(page: Page, text: string) {
  return page.getByText(text).filter({ visible: true }).first();
}

/** 等页面数据读完：网络空闲且没有「…加载中」骨架。 */
async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await expect(page.locator('[aria-label$="加载中"]')).toHaveCount(0);
}

async function openTab(page: Page, tenant: Tenant, tab: string) {
  await page.goto(`/admin/tenants/${tenant.id}${tab ? `?tab=${tab}` : ''}`);
  // 余额卡片只在电脑版显示；标签页导航两种宽度都有。
  await expect(
    page.getByRole('navigation', { name: '租户详情' }),
  ).toBeVisible();
  await settle(page);
}

const importCsv = {
  ok: '﻿ISO,国家,号码前缀,说明,费率\n,中国,86,,0.0550\n,法国,33,,0.0600\n,美国/加拿大,1,,0.0100\n,英国手机,447,,0.0450\n,英国,44,,0.0200\n,新加坡,65,,0.0280\n,日本,81,,0.0350\n,中国香港,852,,0.0300\n',
  errors: [
    'ISO,国家,号码前缀,说明,费率',
    '8a6,中国,0.05',
    ',英国手机,447,,-0.1',
    ',法国,33,,0.06',
    ',美国,1,,0.12345',
    '',
  ].join('\r\n'),
};

async function openImport(page: Page, seed: Seed, csv?: string) {
  await openTab(page, seed.source, 'rates');
  await page.getByRole('button', { name: '导入 CSV' }).click();
  const dialog = page.getByRole('dialog', { name: '导入费率表' });
  await expect(dialog).toBeVisible();
  if (csv === undefined) return dialog;
  await dialog.getByLabel('选择 CSV 文件').setInputFiles({
    name: '费率_修订版.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await dialog.getByRole('button', { name: '下一步：预览' }).click();
  return dialog;
}

async function openCopy(page: Page, seed: Seed) {
  await openTab(page, seed.source, 'rates');
  await page.getByRole('button', { name: '复制到其他租户' }).click();
  const dialog = page.getByRole('dialog', { name: '复制费率表到其他租户' });
  await dialog.getByLabel('搜索租户编码或名称').fill(seed.target.code);
  await dialog
    .getByRole('radio', { name: new RegExp(seed.target.code) })
    .check();
  await expect(dialog.getByText(/已选：.*· \d+ 条/)).toBeVisible();
  return dialog;
}

/** 手机端不提供导入与复制，费率标签页提示「请在电脑上操作」。 */
async function openMobileRates(page: Page, seed: Seed) {
  await openTab(page, seed.source, 'rates');
  await expect(page.getByText('请在电脑上操作')).toBeVisible();
}

/** 稿中确实没有对应画框：写明原因，index.json 记为 no matching frame，不算失败。 */
type AbsentFrame = { absent: string };
type FrameRef = DesignFrame | AbsentFrame;

type Shot = {
  name: string;
  /** 电脑浅色与深色对照的画框。声明了画框就必须截到，截不到即失败。 */
  desktop: FrameRef;
  /** 手机对照的画框；省略时退回电脑浅色画框。 */
  mobile?: FrameRef;
  viewport: { width: number; height: number };
  /** 截整页（对话框只截视口）。 */
  fullPage: boolean;
  variants?: Variant[];
  note?: string;
  /** 走到要截图的状态，返回后即截图。 */
  open: (page: Page, seed: Seed, variant: Variant) => Promise<unknown>;
  /** 需要另一个会话（例如强制改密的新管理员）时由它建页。 */
  session?: 'forced';
};

const shots: Shot[] = [
  {
    name: 'tenant-list',
    desktop: frame(batch1, '租户列表', '1a 电脑'),
    mobile: frame(batch1, '租户列表', '1b 手机'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page) => {
      await page.goto('/admin/tenants');
      await expect(visibleText(page, 'ABC001')).toBeVisible();
      await settle(page);
    },
  },
  {
    name: 'tenant-create',
    desktop: frame(batch2, '新建 / 编辑租户', '4a 电脑 · 空白表单'),
    mobile: frame(batch2, '新建租户 · 手机与成功', '4a 手机 · 空白表单'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page) => {
      await page.goto('/admin/tenants/new');
      await expect(
        page.getByRole('button', { name: '创建租户' }),
      ).toBeVisible();
      await settle(page);
    },
  },
  {
    name: 'tenant-create-success',
    desktop: frame(batch2, '新建租户 · 手机与成功', '4e 电脑 · 创建成功'),
    mobile: frame(batch2, '新建租户 · 手机与成功', '4e 手机 · 创建成功'),
    viewport: dialogViewport,
    fullPage: false,
    open: async (page, seed, variant) => {
      const code = `${seed.run}N${variant[0]!.toUpperCase()}`;
      await page.goto('/admin/tenants/new');
      await page.getByLabel(/租户编码/).fill(code);
      await page.getByLabel(/租户名称/).fill('上海某某信息技术有限公司');
      await page.getByLabel(/余额提醒阈值/).fill('200');
      await page
        .getByLabel(/登录邮箱/)
        .fill(`${code.toLowerCase()}@example.com`);
      await page.getByRole('button', { name: '创建租户' }).click();
      await expect(
        page
          .getByRole('dialog', { name: `租户 ${code} 已创建` })
          .getByRole('textbox', { name: '临时密码', exact: true }),
      ).toBeVisible();
    },
  },
  {
    name: 'tenant-edit',
    desktop: frame(
      batch2,
      '新建 / 编辑租户',
      '5a 电脑 · 编辑租户（编码、币种只读）',
    ),
    mobile: frame(batch2, '新建租户 · 手机与成功', '5a 手机 · 编辑租户'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page, seed) => {
      await page.goto(`/admin/tenants/${seed.cny.id}/edit`);
      await expect(page.getByLabel(/租户名称/)).toHaveValue(
        '深圳市某某科技有限公司',
      );
      await settle(page);
    },
  },
  {
    name: 'tenant-overview',
    desktop: frame(detail3, '租户详情 电脑', '1a 概况'),
    mobile: frame(detail3, '租户详情 手机', '3a 概况'),
    viewport: pageViewport,
    fullPage: true,
    open: (page, seed) => openTab(page, seed.cny, ''),
  },
  {
    name: 'tenant-ledger',
    desktop: frame(batch1, '租户详情', '2a 电脑 · ABC001 透支中'),
    mobile: frame(batch1, '租户详情', '2b 手机'),
    viewport: pageViewport,
    fullPage: true,
    note: '第三批租户详情没有余额流水画框，对照第一批租户详情。',
    open: (page, seed) => openTab(page, seed.cny, 'ledger'),
  },
  {
    name: 'tenant-rates',
    desktop: frame(
      batch2,
      '费率标签页',
      '7a 电脑 · 费率标签页（当前生效版本）',
    ),
    mobile: frame(batch2, '费率标签页', '7c 手机 · 查看与搜索（含排定版本）'),
    viewport: pageViewport,
    fullPage: true,
    open: (page, seed) => openTab(page, seed.source, 'rates'),
  },
  {
    name: 'tenant-rates-scheduled',
    desktop: frame(batch2, '费率标签页', '7b 电脑 · 有排定的新版本'),
    mobile: frame(batch2, '费率标签页', '7c 手机 · 查看与搜索（含排定版本）'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page, seed) => {
      await openTab(page, seed.cny, 'rates');
      await expect(
        page.getByRole('region', { name: '排定的新版本' }),
      ).toBeVisible();
    },
  },
  {
    name: 'tenant-settings',
    desktop: frame(detail3, '租户详情 电脑', '1h 设置 · 已修改，待保存'),
    mobile: frame(detail3, '租户详情 手机', '3h 设置'),
    viewport: pageViewport,
    fullPage: true,
    open: (page, seed) => openTab(page, seed.cny, 'settings'),
  },
  {
    name: 'tenant-portal',
    desktop: frame(detail3, '租户详情 电脑', '1j 门户账号'),
    mobile: frame(detail3, '租户详情 手机', '3j 门户账号'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page, seed) => {
      await openTab(page, seed.cny, 'portal');
      await expect(
        page.getByRole('region', { name: '客户门户账号' }),
      ).toContainText(`${seed.cny.code.toLowerCase()}@example.com`);
    },
  },
  {
    name: 'balance-dialog',
    desktop: frame(batch1, '余额操作对话框', '3a 充值（备注客户可见）'),
    mobile: frame(batch1, '余额操作对话框', '3e 手机 · 底部弹出面板'),
    viewport: dialogViewport,
    fullPage: false,
    open: async (page, seed) => {
      await openTab(page, seed.cny, '');
      await page.getByRole('button', { name: '余额操作' }).click();
      const dialog = page.getByRole('dialog', { name: '余额操作' });
      await dialog.getByRole('radio', { name: '充值', exact: true }).check();
      await dialog.getByLabel('金额').fill('1000');
      await dialog.getByLabel(/备注/).fill('9 月对公转账');
    },
  },
  {
    name: 'balance-confirm',
    desktop: frame(batch1, '余额操作对话框', '3d 二次确认'),
    viewport: dialogViewport,
    fullPage: false,
    open: async (page, seed) => {
      await openTab(page, seed.cny, '');
      await page.getByRole('button', { name: '余额操作' }).click();
      const dialog = page.getByRole('dialog', { name: '余额操作' });
      await dialog.getByRole('radio', { name: '充值', exact: true }).check();
      await dialog.getByLabel('金额').fill('1000');
      await dialog.getByRole('button', { name: '下一步' }).click();
      await expect(
        dialog.getByRole('button', { name: '确认充值' }),
      ).toBeVisible();
    },
  },
  {
    name: 'rates-import-upload',
    desktop: frame(batch2, '导入 CSV · 上传', '1a 未选择文件 · 立即生效'),
    mobile: frame(
      batch2,
      '导入 CSV · 上传',
      '1c 手机 · 费率标签页（导入请在电脑上操作）',
    ),
    viewport: dialogViewport,
    fullPage: false,
    note: '手机端不提供导入，手机变体截费率标签页的「请在电脑上操作」提示。',
    open: (page, seed, variant) =>
      variant === 'mobile'
        ? openMobileRates(page, seed)
        : openImport(page, seed),
  },
  {
    name: 'rates-import-preview',
    desktop: frame(batch2, '导入 CSV · 预览与确认', '2a 校验通过 · 预览变动'),
    viewport: dialogViewport,
    fullPage: false,
    variants: ['light', 'dark'],
    note: '手机端不提供导入，见 rates-import-upload 手机变体。',
    open: async (page, seed) => {
      const dialog = await openImport(page, seed, importCsv.ok);
      await expect(
        dialog.getByRole('button', { name: '确认导入' }),
      ).toBeVisible();
    },
  },
  {
    name: 'rates-import-errors',
    desktop: frame(batch2, '导入 CSV · 预览与确认', '2b 校验失败 · 不能继续'),
    viewport: dialogViewport,
    fullPage: false,
    variants: ['light', 'dark'],
    note: '手机端不提供导入，见 rates-import-upload 手机变体。',
    open: async (page, seed) => {
      const dialog = await openImport(page, seed, importCsv.errors);
      await expect(dialog.getByRole('alert')).toContainText('发现 3 处错误');
    },
  },
  {
    name: 'rates-copy-target',
    desktop: frame(batch2, '复制到其他租户', '9a ① 选择目标租户 · ② 覆盖提示'),
    mobile: frame(
      batch2,
      '复制到其他租户',
      '9d 手机 · 复制 / 导入 → 请在电脑上操作',
    ),
    viewport: dialogViewport,
    fullPage: false,
    note: '手机端不提供复制，手机变体截费率标签页的「请在电脑上操作」提示。',
    open: (page, seed, variant) =>
      variant === 'mobile' ? openMobileRates(page, seed) : openCopy(page, seed),
  },
  {
    name: 'rates-copy-preview',
    desktop: frame(batch2, '复制到其他租户', '9b ③ 预览变动 · ④ 生效时间'),
    viewport: dialogViewport,
    fullPage: false,
    variants: ['light', 'dark'],
    note: '手机端不提供复制，见 rates-copy-target 手机变体。',
    open: async (page, seed) => {
      const dialog = await openCopy(page, seed);
      await dialog.getByRole('button', { name: '下一步：预览变动' }).click();
      await expect(dialog).toContainText(`${seed.target.code} 的费率表将新增`);
    },
  },
  {
    name: 'receivables-pending',
    desktop: frame(batch2, '待收款', '6a 电脑 · 列表（超过 30 天高亮）'),
    mobile: frame(batch2, '待收款', '6b 手机 · 列表'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page, seed) => {
      await page.goto(`/admin/receivables?search=${seed.run}`);
      await expect(visibleText(page, seed.cny.code)).toBeVisible();
      await expect(visibleText(page, '42 天')).toBeVisible();
      await settle(page);
    },
  },
  {
    name: 'receivables-received',
    desktop: frame(batch2, '待收款', '6a 电脑 · 列表（超过 30 天高亮）'),
    mobile: frame(batch2, '待收款', '6b 手机 · 列表'),
    viewport: pageViewport,
    fullPage: true,
    note: '稿中只有待收款列表，已收款视图对照待收款画框。',
    open: async (page, seed) => {
      await page.goto('/admin/receivables?status=received');
      await expect(visibleText(page, seed.cny.code)).toBeVisible();
      await settle(page);
    },
  },
  {
    name: 'receivables-voided',
    desktop: frame(batch2, '待收款', '6a 电脑 · 列表（超过 30 天高亮）'),
    mobile: frame(batch2, '待收款', '6b 手机 · 列表'),
    viewport: pageViewport,
    fullPage: true,
    note: '稿中只有待收款列表，已作废视图对照待收款画框。',
    open: async (page, seed) => {
      await page.goto('/admin/receivables?status=voided');
      await expect(visibleText(page, seed.cny.code)).toBeVisible();
      await settle(page);
    },
  },
  {
    name: 'receivables-confirm',
    desktop: frame(batch2, '待收款', '6c 电脑 · 确认收款对话框'),
    mobile: frame(batch2, '待收款', '6d 手机 · 确认收款（底部弹出）'),
    viewport: dialogViewport,
    fullPage: false,
    open: async (page, seed) => {
      await page.goto(`/admin/receivables?search=${seed.cny.code}`);
      await settle(page);
      await page
        .getByRole('button', { name: `确认收款 ${seed.cny.code} ¥1,300.00` })
        .click();
      await expect(
        page.getByRole('dialog', { name: '确认收款' }),
      ).toBeVisible();
    },
  },
  {
    name: 'admin-accounts',
    desktop: frame(
      system3,
      '管理员',
      '2a 电脑 · 列表（王敏的「停用」悬停提示）',
    ),
    mobile: frame(system3, '管理员', '2b 手机 · 列表'),
    viewport: pageViewport,
    fullPage: true,
    open: async (page, seed) => {
      await page.goto('/admin/admins');
      await expect(visibleText(page, seed.admin.email)).toBeVisible();
      await settle(page);
    },
  },
  {
    name: 'admin-temporary-password',
    desktop: frame(system3, '管理员', '2d 电脑 · 重置密码结果（只显示一次）'),
    mobile: frame(system3, '管理员', '2h 手机 · 重置密码结果'),
    viewport: dialogViewport,
    fullPage: false,
    open: async (page, seed, variant) => {
      await page.goto(`/admin/admins?search=${seed.admin.email}`);
      await settle(page);
      if (variant === 'mobile') {
        await page
          .getByRole('button', { name: `${seed.admin.name} 的操作` })
          .click();
        await page
          .getByRole('dialog', { name: `${seed.admin.name} 的操作` })
          .getByRole('button', { name: '重置密码' })
          .click();
      } else
        await page
          .getByRole('button', { name: `重置 ${seed.admin.name} 的密码` })
          .click();
      await page
        .getByRole('dialog', { name: `重置 ${seed.admin.name} 的密码？` })
        .getByRole('button', { name: '重置密码' })
        .click();
      await expect(
        page
          .getByRole('dialog', { name: `已为 ${seed.admin.name} 生成临时密码` })
          .getByRole('textbox', { name: '临时密码', exact: true }),
      ).toBeVisible();
    },
  },
  {
    name: 'forced-change-password',
    desktop: frame(portal3, '账号设置 电脑', '2a 默认'),
    mobile: frame(portal3, '账号设置 手机', '2a 手机 · 默认'),
    viewport: { width: 1200, height: 800 },
    fullPage: true,
    session: 'forced',
    note: '管理后台没有改密画框；按已定口径复用客户门户「账号设置」卡片，放在登录布局。',
    open: async (page) => {
      await expect(
        page.getByRole('heading', { name: '请修改初始密码' }),
      ).toBeVisible();
      await settle(page);
    },
  },
];

/** 终端颜色码（ESC [ … m），写入 index.json 前去掉。 */
const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

type IndexEntry = {
  page: string;
  variant: Variant;
  designFrame: DesignFrame | null;
  designTheme: 'light' | 'dark' | null;
  note: string | null;
  files: { design: string | null; app: string | null; compare: string | null };
  error?: string;
};

function contextOptions(
  variant: Variant,
  storageState?: BrowserContextOptions['storageState'],
): BrowserContextOptions {
  return {
    baseURL: webOrigin,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    colorScheme: variant === 'dark' ? 'dark' : 'light',
    ...(storageState ? { storageState } : {}),
  };
}

/** 新管理员首次用临时密码登录，被带到强制改密页。 */
async function forcedSession(browser: Browser, variant: Variant, seed: Seed) {
  const context = await browser.newContext(contextOptions(variant));
  await context.addInitScript(() =>
    localStorage.setItem('fs-billing.theme', 'system'),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto('/admin/login');
  const response = await submitLogin(
    page,
    seed.forced.email,
    seed.forced.password,
  );
  expect(response.status()).toBe(200);
  await expectPath(page, '/admin/change-password');
  return { context, page };
}

test('matches seeded admin pages in light dark and mobile', async ({
  browser,
  page: seedPage,
  adminSession,
}) => {
  test.setTimeout(45 * 60_000);
  const outDir = join(
    process.env['FSB_EVIDENCE_DIR'] ?? '/workspace/fsb-evidence/phase-5-web',
    'visual',
  );
  mkdirSync(outDir, { recursive: true });
  const seeded = await seed(seedPage);
  const designs = await serveDesigns();
  const designPage = await browser.newPage();
  const index: IndexEntry[] = [];

  try {
    for (const variant of variants) {
      const context = await browser.newContext(
        contextOptions(variant, adminSession),
      );
      await context.addInitScript(() =>
        localStorage.setItem('fs-billing.theme', 'system'),
      );
      const appPage = await context.newPage();
      appPage.setDefaultTimeout(20_000);
      for (const shot of shots) {
        if (!(shot.variants ?? variants).includes(variant)) continue;
        const mobileFrame = shot.mobile ?? shot.desktop;
        const frameRef = variant === 'mobile' ? mobileFrame : shot.desktop;
        const designFrame = 'absent' in frameRef ? null : frameRef;
        const designTheme = variant === 'dark' ? 'dark' : 'light';
        const notes = [shot.note];
        if (variant === 'mobile' && shot.mobile === undefined && designFrame)
          notes.push('稿中没有手机画框，对照电脑浅色画框。');
        if ('absent' in frameRef)
          notes.push(`no matching frame: ${frameRef.absent}`);
        const entry: IndexEntry = {
          page: shot.name,
          variant,
          designFrame,
          designTheme: designFrame ? designTheme : null,
          note: notes.filter(Boolean).join(' ') || null,
          files: { design: null, app: null, compare: null },
        };
        index.push(entry);
        const name = `${shot.name}-${variant}`;
        let forced: Awaited<ReturnType<typeof forcedSession>> | null = null;
        try {
          if (shot.session === 'forced')
            forced = await forcedSession(browser, variant, seeded);
          const page = forced?.page ?? appPage;
          await page.setViewportSize(
            variant === 'mobile' ? mobileViewport : shot.viewport,
          );
          await shot.open(page, seeded, variant);
          const app = join(outDir, `app-${name}.png`);
          await page.screenshot({
            path: app,
            fullPage: shot.fullPage,
            animations: 'disabled',
          });
          entry.files.app = app;
        } catch (error) {
          entry.error = `app: ${String(error).replace(ansiColor, '')}`;
        } finally {
          await forced?.context.close();
        }
        if (!designFrame) continue;
        const design = join(outDir, `design-${name}.png`);
        try {
          await captureDesignFrame(
            designPage,
            designs.origin,
            designFrame,
            designTheme,
            design,
            15_000,
          );
          entry.files.design = design;
        } catch (error) {
          const message = `design ${designFrame.section} / ${designFrame.label}: ${String(error).replace(ansiColor, '')}`;
          entry.error = entry.error ? `${entry.error}; ${message}` : message;
        }
        if (entry.files.design && entry.files.app) {
          const compare = join(outDir, `compare-${name}.png`);
          writeComposite(entry.files.design, entry.files.app, compare);
          entry.files.compare = compare;
        }
      }
      await context.close();
    }
  } finally {
    writeFileSync(
      join(outDir, 'index.json'),
      `${JSON.stringify({ run: seeded.run, entries: index }, null, 2)}\n`,
    );
    await designPage.close();
    await designs.close();
  }
  expect(
    index
      .filter((entry) => entry.error)
      .map((e) => `${e.page}-${e.variant}: ${e.error}`),
  ).toEqual([]);
});
