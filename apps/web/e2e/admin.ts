import {
  test as base,
  expect,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { accounts, password } from './accounts';
import { webOrigin } from './env';
import { expectPath, retryRateLimited } from './helpers';

type StorageState = Awaited<ReturnType<APIRequestContext['storageState']>>;

/**
 * 后台用例共用管理员会话：每个 worker 经接口登录一次，各用例以该会话启动。
 * 登录与改密码共享每 IP 每分钟 30 次的凭据限流，逐个用例登录会挤占 auth.spec 的额度；
 * 管理员登录页本身由 auth.spec 覆盖。额度已用完时按 Retry-After 等待重试。
 */
export const test = base.extend<object, { adminSession: StorageState }>({
  adminSession: [
    async ({ playwright }, use) => {
      const request = await playwright.request.newContext({
        baseURL: webOrigin,
      });
      const response = await retryRateLimited(
        () =>
          request.post('/api/auth/login', {
            data: { email: accounts.admin, password: password() },
          }),
        () => {},
      );
      expect(response.status()).toBe(200);
      const state = await request.storageState();
      await request.dispose();
      await use(state);
    },
    // 最多等待 3 次 60 秒限流窗口。
    { scope: 'worker', timeout: 4 * 61_000 },
  ],
  storageState: ({ adminSession }, use) => use(adminSession),
});

/** 每次运行用新编码，避免与种子数据或上次运行冲突。 */
export function uniqueCode(prefix = 'E2E') {
  return `${prefix}${Date.now().toString(36).toUpperCase()}`;
}

export async function openTenants(page: Page) {
  await page.goto('/admin');
  await expectPath(page, '/admin');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '租户' })
    .click();
  await expectPath(page, '/admin/tenants');
}

/**
 * 通过后台接口准备一个本次运行专用的租户（空白费率表），返回其 id 与编码。
 * 请求复用页面的管理员会话 cookie。
 */
export async function createTenant(
  page: Page,
  options: {
    currency?: 'CNY' | 'USD';
    emails?: string[];
  } = {},
) {
  const code = uniqueCode();
  const response = await page.request.post('/api/admin/tenants', {
    data: {
      code,
      name: `端到端 ${code}`,
      currency: options.currency ?? 'CNY',
      settings: {
        lowBalanceThreshold: '200',
        ...(options.emails ? { emails: options.emails } : {}),
      },
      initialRates: { kind: 'blank' },
    },
  });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { tenant: { id: string } };
  return { id: body.tenant.id, code };
}

export async function disableTenant(page: Page, tenantId: string) {
  const response = await page.request.post(
    `/api/admin/tenants/${tenantId}/disable`,
    { data: {} },
  );
  expect(response.ok()).toBe(true);
}

/** 打开余额操作对话框，填写并进入确认页。 */
export async function fillBalance(
  page: Page,
  kind: '充值' | '赊账充值' | '赠送' | '调账',
  amount: string,
  note = '',
) {
  await page.getByRole('button', { name: '余额操作' }).click();
  const dialog = page.getByRole('dialog', { name: '余额操作' });
  await dialog.getByRole('radio', { name: kind, exact: true }).check();
  await dialog.getByLabel('金额').fill(amount);
  if (note) await dialog.getByLabel(/备注/).fill(note);
  await dialog.getByRole('button', { name: '下一步' }).click();
  return dialog;
}
