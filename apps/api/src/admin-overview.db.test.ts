import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminBalanceOperationResponseSchema,
  adminOverviewResponseSchema,
  adminReceivablesResponseSchema,
  adminSystemAlertsResponseSchema,
  adminSystemAlertsSummaryResponseSchema,
  adminTenantsResponseSchema,
  adminUnassignedSummaryResponseSchema,
} from '@fs-billing/shared';
import { raiseAlert, recoverAlert, withSystem } from '@fs-billing/db';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

/**
 * 阶段 9 验收 5 的 API 测试：概览页的待收款合计、告警数与对应页面的数字一致。
 * 概览与各页面是同一份函数 / 谓词，所以在静止的库上逐项断言相等；时间相关的口径（窗口、北京日）
 * 在 packages/db/src/overview.db.test.ts 用固定时钟测，这里只走真实 HTTP 的路径。
 */
const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let cookie: string;

const get = (url: string) =>
  api.inject({ url, headers: requestHeaders(cookie) });
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
const raise = (input: Parameters<typeof raiseAlert>[1]) =>
  withSystem(connections.app.db, (tx) => raiseAlert(tx, input));
const num = (text: string) => Number(text);

async function overview() {
  const response = await get('/api/admin/overview');
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return adminOverviewResponseSchema.parse(response.json());
}
async function credit(
  tenantId: string,
  currency: 'CNY' | 'USD',
  amount: string,
) {
  const response = await api.inject({
    method: 'POST',
    url: `/api/admin/tenants/${tenantId}/balance-operations`,
    headers: requestHeaders(cookie),
    payload: {
      kind: 'credit_topup',
      currency,
      amount,
      internalNote: '概览测试赊账',
      idempotencyKey: randomUUID(),
    },
  });
  expect(response.statusCode, response.body).toBe(200);
  return adminBalanceOperationResponseSchema.parse(response.json()).entry.id;
}
const receivables = async () =>
  adminReceivablesResponseSchema.parse(
    (await get('/api/admin/receivables?status=pending&pageSize=1')).json(),
  );
const tenantsWith = async (status: string) =>
  adminTenantsResponseSchema.parse(
    (await get(`/api/admin/tenants?status=${status}&pageSize=1`)).json(),
  ).pagination.total;

beforeAll(async () => {
  fixture = await createFixture(connections);
  cookie = (await login(api, fixture.admin)).cookie;
});
beforeEach(async () => {
  await connections.owner.pool.query(
    "delete from email_outbox where template like 'alert\\_%'",
  );
  await connections.owner.pool.query('delete from system_alerts');
});

// 并发用例留下了很多进行中的告警。
afterAll(async () => {
  await connections.owner.pool.query('delete from system_alerts');
});

describe('GET /api/admin/overview', () => {
  it('overview receivable totals equal the receivables page totals', async () => {
    const before = await overview();
    await credit(fixture.a.tenantId!, 'CNY', '123.45');
    await credit(fixture.b.tenantId!, 'USD', '67.89');
    const after = await overview();
    const page = await receivables();
    expect(after.metrics.pendingReceivable).toEqual(page.totals);
    // 新增的两笔赊账恰好是差额，并且按币种分开、不相加。
    expect(
      num(after.metrics.pendingReceivable.CNY) -
        num(before.metrics.pendingReceivable.CNY),
    ).toBeCloseTo(123.45, 3);
    expect(
      num(after.metrics.pendingReceivable.USD) -
        num(before.metrics.pendingReceivable.USD),
    ).toBeCloseTo(67.89, 3);
  });

  it('overview alert count equals the alerts page total for the same window', async () => {
    await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '进行中，三十小时前开始',
      calls: 5,
      at: hoursAgo(30),
    });
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'recently-recovered',
      description: '刚恢复',
      at: hoursAgo(5),
    });
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'long-gone',
      description: '早已恢复',
      at: hoursAgo(80),
    });
    await withSystem(connections.app.db, async (tx) => {
      await recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'recently-recovered',
        at: hoursAgo(4),
      });
      await recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'long-gone',
        at: hoursAgo(70),
      });
    });
    const result = await overview();
    const page = adminSystemAlertsResponseSchema.parse(
      (await get('/api/admin/system-alerts?window=24h')).json(),
    );
    expect(result.attention.alerts.last24h).toBe(page.pagination.total);
    expect(result.attention.alerts.last24h).toBe(2);
    expect(result.attention.alerts.open).toBe(page.openCount);
    expect(result.attention.alerts.items).toEqual(page.items.slice(0, 5));
    const summary = adminSystemAlertsSummaryResponseSchema.parse(
      (await get('/api/admin/system-alerts/summary')).json(),
    );
    expect(summary.open).toBe(result.attention.alerts.open);
    expect(summary.last24h).toBe(result.attention.alerts.last24h);
    // 没有告警时两处都是 0（页面空状态）。
    await connections.owner.pool.query('delete from system_alerts');
    const empty = await overview();
    expect(empty.attention.alerts).toEqual({ open: 0, last24h: 0, items: [] });
  });

  it('uses the tenant list and unassigned page numbers', async () => {
    const result = await overview();
    expect(result.metrics.suspendedTenants).toBe(
      await tenantsWith('suspended'),
    );
    expect(result.attention.suspended.total).toBe(
      await tenantsWith('suspended'),
    );
    expect(result.attention.lowBalance.total).toBe(
      (await tenantsWith('overdraft')) + (await tenantsWith('low_balance')),
    );
    expect(result.attention.unassigned.pending).toBe(
      adminUnassignedSummaryResponseSchema.parse(
        (await get('/api/admin/unassigned-cdrs/summary')).json(),
      ).pending,
    );
    const total = await connections.owner.pool.query<{ n: number }>(
      'select count(*)::int as n from tenants',
    );
    expect(result.metrics.tenantCount).toBe(total.rows[0]!.n);
    // 近 30 天按北京日连续，最后一天就是 asOf 的北京日。
    const beijingDay = new Date(Date.parse(result.asOf) + 8 * 3_600_000)
      .toISOString()
      .slice(0, 10);
    expect(result.dailySpend.at(-1)?.date).toBe(beijingDay);
  });

  it('overview figures come from one snapshot', async () => {
    // 后台不停地开新告警，同时反复取概览：每一份响应内部必须自洽
    //（条数、列表、进行中的数来自同一个快照），不会出现「条数是 N、列表却多一条」。
    let stop = false;
    const writer = (async () => {
      for (let index = 0; !stop && index < 60; index++)
        await raise({
          kind: 'cdr_failed',
          subjectKey: `burst-${index}`,
          description: `并发 ${index}`,
        });
    })();
    try {
      for (let round = 0; round < 15; round++) {
        const result = await overview();
        const { open, last24h, items } = result.attention.alerts;
        expect(items.length).toBe(Math.min(5, last24h));
        expect(open).toBeLessThanOrEqual(last24h);
        expect(
          items.filter((item) => item.status === 'open').length,
        ).toBeLessThanOrEqual(open);
      }
    } finally {
      stop = true;
      await writer;
    }
  });
});
