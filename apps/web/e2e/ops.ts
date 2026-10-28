import { expect, type Page } from '@playwright/test';
import { accounts } from './accounts';
import { createTenant } from './admin';
import { cdrRates } from './cdr-fixtures';
import {
  backdateTenant,
  recordLedgerEntry,
  recordStatementCall,
  recordUnassigned,
  setStatementFlags,
  type UnassignedFixture,
} from './db';

/**
 * 阶段 8 话单运维 e2e 共用的夹具。每个用例用自己的租户与自己的标签，
 * 不碰 ABC001 与种子里的 ABC01 组，所以其他用例看到的种子数字不变。
 */

/** 管理员 wangmin@example.com 的名字（packages/db/src/seed.ts）。 */
export const adminName = '王敏';

/** 与租户编码只差一个字符的标签：分组卡片会提示「相近：编码」。 */
export const typoTag = (code: string) => `${code}X`;

/** 一通 61 秒（2 个计费分钟）的话单按 cdrRates 的价格：86 为 0.10，44 为 0.04，447 为 0.09。 */
export const assignRows: readonly UnassignedFixture[] = [
  { callee: '8613800138000' },
  { callee: '8613912345678' },
  { callee: '442071234567' },
  // 33 没有费率：预览里匹配不到费率，留在待处理。
  { callee: '33123456789' },
];
export const assignRowsCharge = '0.24';
export const assignRowsAssignable = 3;

/**
 * 一个带费率表的新租户和它的「拼写错误」标签下的待处理话单：默认四条（含一条没有费率的）；
 * `noRate: false` 时只有三条都有费率的，整组归属后不留待处理话单（视觉对照用，不改全局的待处理数）。
 */
export async function assignableTenant(
  page: Page,
  options: { noRate?: boolean } = {},
) {
  const tenant = await createTenant(page, { rates: cdrRates });
  const tag = typoTag(tenant.code);
  await recordUnassigned(
    tag,
    options.noRate === false ? assignRows.slice(0, 3) : assignRows,
  );
  return { ...tenant, tag };
}

/** 北京时间的当前月与上一个月，格式 YYYY-MM；用来在界面里找「当月」。 */
export function currentMonth(now = new Date()) {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

export const monthLabel = (month: string) =>
  `${month.slice(0, 4)}年${Number(month.slice(5))}月`;

/**
 * 8、9 月各有一笔充值和一通已接通电话、账单已生成、核对通过的租户：两个月都可删除。
 * 8 月 1 条话单（1.5 元），9 月 1 条话单（2 元）。
 */
export async function deletableTenant(page: Page) {
  const tenant = await createTenant(page);
  await backdateTenant(tenant.id, '2026-08-05T10:00:00+08:00');
  await recordLedgerEntry(tenant.id, {
    kind: 'recharge',
    amount: '1000',
    at: '2026-08-06T10:00:00+08:00',
    adminEmail: accounts.admin,
  });
  await recordStatementCall(tenant.id, {
    answeredAt: '2026-08-10T10:00:00+08:00',
    minutes: '3',
    charge: '1.5',
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
  });
  for (const month of ['2026-08', '2026-09']) {
    const response = await page.request.post(
      `/api/admin/tenants/${tenant.id}/statements/${month}/regenerate`,
      { data: { expectedVersion: 0 } },
    );
    expect(response.status()).toBe(200);
    // 核对任务由 Worker 运行，e2e 不启动 Worker，核对通过由这里置。
    await setStatementFlags(tenant.id, month, { reconcileStatus: 'ok' });
  }
  return tenant;
}

/** 租户话单标签页的地址：2026 年 8 月全月。 */
export const cdrTabUrl = (tenantId: string, extra = '') =>
  `/admin/tenants/${tenantId}?tab=cdrs&cdrFrom=2026-08-01&cdrTo=2026-08-31${extra}`;
