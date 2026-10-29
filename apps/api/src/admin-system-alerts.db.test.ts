import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adminAlertSettingsResponseSchema,
  adminAlertSettingsUpdateResponseSchema,
  adminApiErrorSchema,
  adminAuditLogsResponseSchema,
  adminSystemAlertDetailSchema,
  adminSystemAlertsResponseSchema,
  adminSystemAlertsSummaryResponseSchema,
  ALERT_KIND_LABELS,
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

const connections = apiConnections();
const { api } = fixtureApi(connections);
const mailApi = fixtureApi(connections, { mailEnabled: true }).api;
let fixture: Fixture;
let cookie: string;

const get = (url: string, from = api) =>
  from.inject({ url, headers: requestHeaders(cookie) });
const put = (payload: object, from = api, as = cookie) =>
  from.inject({
    method: 'PUT',
    url: '/api/admin/alert-settings',
    headers: requestHeaders(as),
    payload,
  });
const post = (url: string, as = cookie) =>
  api.inject({ method: 'POST', url, headers: requestHeaders(as) });
const raise = (input: Parameters<typeof raiseAlert>[1]) =>
  withSystem(connections.app.db, (tx) => raiseAlert(tx, input));
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

const resetSettings = () =>
  connections.owner.pool.query(
    `update alert_settings set recipients = '{}', digest_minutes = 15, version = 1, updated_by = null`,
  );

beforeAll(async () => {
  fixture = await createFixture(connections);
  cookie = (await login(api, fixture.admin)).cookie;
});
beforeEach(async () => {
  await connections.owner.pool.query(
    "delete from email_outbox where template like 'alert\\_%'",
  );
  await connections.owner.pool.query('delete from system_alerts');
  await resetSettings();
});
// 别的测试文件期望告警设置是迁移的默认值（版本 1）。
afterAll(resetSettings);

describe('GET /api/admin/system-alerts', () => {
  it('lists open alerts first, filters by status, kind and window, and pages', async () => {
    await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: '授权超时放行',
      calls: 23,
      at: hoursAgo(3),
    });
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'cdr-save',
      description: '保存失败',
      at: hoursAgo(50),
    });
    await withSystem(connections.app.db, (tx) =>
      recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'cdr-save',
        at: hoursAgo(49),
      }),
    );
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'old',
      description: '四十天前',
      at: hoursAgo(24 * 40),
    });
    await withSystem(connections.app.db, (tx) =>
      recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'old',
        at: hoursAgo(24 * 39),
      }),
    );

    const response = await get('/api/admin/system-alerts');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const all = adminSystemAlertsResponseSchema.parse(response.json());
    // 默认窗口 30 天：四十天前恢复的不在；进行中的在前。
    expect(all.items.map((item) => item.description)).toEqual([
      '授权超时放行',
      '保存失败',
    ]);
    expect(all.pagination).toEqual({ page: 1, pageSize: 25, total: 2 });
    expect(all.openCount).toBe(1);
    expect(all.items[0]).toMatchObject({
      kind: 'auth_timeout',
      kindLabel: ALERT_KIND_LABELS['auth_timeout'],
      status: 'open',
      affectedCalls: 23,
      recoveredAt: null,
    });
    expect(all.items[1]?.status).toBe('recovered');

    const day = adminSystemAlertsResponseSchema.parse(
      (await get('/api/admin/system-alerts?window=24h')).json(),
    );
    expect(day.items.map((item) => item.description)).toEqual(['授权超时放行']);
    const everything = adminSystemAlertsResponseSchema.parse(
      (await get('/api/admin/system-alerts?window=all')).json(),
    );
    expect(everything.pagination.total).toBe(3);
    const recovered = adminSystemAlertsResponseSchema.parse(
      (
        await get('/api/admin/system-alerts?window=all&status=recovered')
      ).json(),
    );
    expect(recovered.items.map((item) => item.description)).toEqual([
      '保存失败',
      '四十天前',
    ]);
    expect(recovered.openCount).toBe(1);
    const failed = adminSystemAlertsResponseSchema.parse(
      (await get('/api/admin/system-alerts?window=all&kind=cdr_failed')).json(),
    );
    expect(failed.pagination.total).toBe(2);
    const paged = adminSystemAlertsResponseSchema.parse(
      (
        await get('/api/admin/system-alerts?window=all&page=2&pageSize=2')
      ).json(),
    );
    expect(paged.items.map((item) => item.description)).toEqual(['四十天前']);
  });

  it('rejects unknown filters and extra query keys', async () => {
    for (const query of [
      'window=1y',
      'status=done',
      'kind=bogus',
      'pageSize=101',
      'page=0',
      'tenantId=' + randomUUID(),
    ]) {
      const response = await get(`/api/admin/system-alerts?${query}`);
      expect(response.statusCode, query).toBe(400);
    }
  });
});

describe('GET /api/admin/system-alerts/summary', () => {
  it('matches the list: open count, last 24 hours and the latest opened start', async () => {
    expect(
      adminSystemAlertsSummaryResponseSchema.parse(
        (await get('/api/admin/system-alerts/summary')).json(),
      ),
    ).toEqual({ open: 0, last24h: 0, lastOpenedAt: null });
    await raise({
      kind: 'auth_timeout',
      subjectKey: 'fs-authorize',
      description: 'a',
      at: hoursAgo(5),
    });
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'cdr-save',
      description: 'b',
      at: hoursAgo(1),
    });
    await raise({
      kind: 'cdr_failed',
      subjectKey: 'gone',
      description: 'c',
      at: hoursAgo(100),
    });
    await withSystem(connections.app.db, (tx) =>
      recoverAlert(tx, {
        kind: 'cdr_failed',
        subjectKey: 'gone',
        at: hoursAgo(99),
      }),
    );
    const response = await get('/api/admin/system-alerts/summary');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const summary = adminSystemAlertsSummaryResponseSchema.parse(
      response.json(),
    );
    expect(summary.open).toBe(2);
    expect(summary.last24h).toBe(2);
    const list = adminSystemAlertsResponseSchema.parse(
      (await get('/api/admin/system-alerts?window=24h')).json(),
    );
    expect(summary.last24h).toBe(list.pagination.total);
    expect(summary.open).toBe(list.openCount);
    const newest = list.items.find((item) => item.description === 'b');
    expect(Date.parse(summary.lastOpenedAt!)).toBe(
      Date.parse(newest!.startedAt),
    );
  });
});

describe('GET /api/admin/system-alerts/{alertId}', () => {
  it('returns the detail, 404 for an unknown id and 400 for a malformed one', async () => {
    const { id } = await raise({
      kind: 'cdr_failed',
      subjectKey: 'unassigned:租户不存在:ABC01',
      description: '话单停放到未归属',
      calls: 4,
      at: hoursAgo(2),
    });
    const response = await get(`/api/admin/system-alerts/${id}`);
    expect(response.statusCode, response.body).toBe(200);
    const detail = adminSystemAlertDetailSchema.parse(response.json());
    expect(detail).toMatchObject({
      id,
      kind: 'cdr_failed',
      status: 'open',
      affectedCalls: 4,
      notify: true,
      unassignedFilter: { reason: '租户不存在', tag: 'ABC01' },
      affectedTenants: null,
      notices: [],
    });
    // 响应里没有告警键（内部身份）。
    expect(response.body).not.toContain('subject');

    const missing = await get(`/api/admin/system-alerts/${randomUUID()}`);
    expect(missing.statusCode).toBe(404);
    expect(adminApiErrorSchema.parse(missing.json()).error.code).toBe(
      'NOT_FOUND',
    );
    expect((await get('/api/admin/system-alerts/not-a-uuid')).statusCode).toBe(
      400,
    );
  });
});

describe('告警设置', () => {
  it('reads the defaults and reports whether mail is enabled', async () => {
    const response = await get('/api/admin/alert-settings');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(adminAlertSettingsResponseSchema.parse(response.json())).toEqual({
      recipients: [],
      digestMinutes: 15,
      version: 1,
      mailEnabled: false,
    });
    expect(
      adminAlertSettingsResponseSchema.parse(
        (await get('/api/admin/alert-settings', mailApi)).json(),
      ).mailEnabled,
    ).toBe(true);
  });

  it('saving settings writes one audit entry', async () => {
    const response = await put({
      recipients: ['Ops@Example.com', 'ops@example.com', 'second@example.com'],
      digestMinutes: 10,
      expectedVersion: 1,
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = adminAlertSettingsUpdateResponseSchema.parse(response.json());
    expect(saved).toMatchObject({
      recipients: ['ops@example.com', 'second@example.com'],
      digestMinutes: 10,
      version: 2,
      mailEnabled: false,
    });
    const read = adminAlertSettingsResponseSchema.parse(
      (await get('/api/admin/alert-settings')).json(),
    );
    expect(read).toEqual({
      recipients: ['ops@example.com', 'second@example.com'],
      digestMinutes: 10,
      version: 2,
      mailEnabled: false,
    });
    const logs = await connections.owner.pool.query<{
      id: string;
      admin_id: string;
      tenant_id: string | null;
      target: string;
      details: {
        target: { kind: string; id: string };
        content: Record<string, unknown>;
      };
    }>(
      `select id, admin_id, tenant_id, target, details from operation_logs where id = $1`,
      [saved.auditId],
    );
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({
      id: saved.auditId,
      admin_id: fixture.admin.profileId,
      tenant_id: null,
      target: saved.auditId,
    });
    expect(logs.rows[0]?.details.target).toEqual({
      kind: 'alert_settings',
      id: saved.auditId,
    });
    expect(logs.rows[0]?.details.content).toMatchObject({
      version: 2,
      changes: [
        {
          field: 'alertRecipients',
          before: [],
          after: ['ops@example.com', 'second@example.com'],
        },
        { field: 'digestMinutes', before: '15', after: '10' },
      ],
    });
    // 操作日志页能列出这条（标签「修改设置」）。
    const listed = await get(
      '/api/admin/audit-logs?label=settings&from=2000-01-01&to=2999-12-31',
    );
    expect(listed.statusCode, listed.body).toBe(200);
    expect(
      adminAuditLogsResponseSchema
        .parse(listed.json())
        .items.map((item) => [item.id, item.label]),
    ).toEqual([[saved.auditId, 'settings']]);
  });

  it('alert settings reject a stale version', async () => {
    const logged = () =>
      connections.owner.pool
        .query<{ n: number }>(
          `select count(*)::int as n from operation_logs where action = 'alert_settings_update'`,
        )
        .then((result) => result.rows[0]!.n);
    const before = await logged();
    const first = await put({
      recipients: ['a@example.com'],
      digestMinutes: 20,
      expectedVersion: 1,
    });
    expect(first.statusCode).toBe(200);
    // 另一个管理员也基于版本 1 保存：409，不改任何东西，也不写日志。
    const stale = await put(
      { recipients: ['b@example.com'], digestMinutes: 30, expectedVersion: 1 },
      api,
      (await login(api, fixture.otherAdmin)).cookie,
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(adminApiErrorSchema.parse(stale.json()).error.code).toBe(
      'ALERT_SETTINGS_VERSION_CONFLICT',
    );
    expect(
      adminAlertSettingsResponseSchema.parse(
        (await get('/api/admin/alert-settings')).json(),
      ),
    ).toMatchObject({
      recipients: ['a@example.com'],
      digestMinutes: 20,
      version: 2,
    });
    expect(await logged()).toBe(before + 1);
  });

  it('validates recipients, interval and unknown fields', async () => {
    const valid = { recipients: [], digestMinutes: 15, expectedVersion: 1 };
    const tooMany = Array.from(
      { length: 21 },
      (_, index) => `user${index}@example.com`,
    );
    for (const [label, body] of Object.entries({
      'invalid address': { ...valid, recipients: ['not-an-email'] },
      'display name': { ...valid, recipients: ['A <a@example.com>'] },
      'more than twenty': { ...valid, recipients: tooMany },
      'interval zero': { ...valid, digestMinutes: 0 },
      'interval too long': { ...valid, digestMinutes: 1441 },
      'fractional interval': { ...valid, digestMinutes: 1.5 },
      'missing version': { recipients: [], digestMinutes: 15 },
      'zero version': { ...valid, expectedVersion: 0 },
      'extra field': { ...valid, version: 7 },
    })) {
      const response = await put(body);
      expect({ label, status: response.statusCode }).toEqual({
        label,
        status: 400,
      });
    }
    // 恰好二十个、空列表（发给全部管理员）都可以。
    expect(
      (await put({ ...valid, recipients: tooMany.slice(0, 20) })).statusCode,
    ).toBe(200);
    expect(
      (await put({ ...valid, recipients: [], expectedVersion: 2 })).statusCode,
    ).toBe(200);
    // 浏览器跨站请求按来源检查拒绝（PUT 与 POST 同样要过检查）。
    const crossSite = await api.inject({
      method: 'PUT',
      url: '/api/admin/alert-settings',
      headers: { cookie, origin: 'https://evil.example' },
      payload: { ...valid, expectedVersion: 3 },
    });
    expect(crossSite.statusCode).toBe(403);
  });

  it('refuses to save for an administrator disabled after login', async () => {
    const other = await login(api, fixture.otherAdmin);
    const disabled = await post(
      `/api/admin/admins/${fixture.otherAdmin.profileId}/disable`,
    );
    expect(disabled.statusCode, disabled.body).toBe(200);
    try {
      const response = await put(
        { recipients: ['x@example.com'], digestMinutes: 5, expectedVersion: 1 },
        api,
        other.cookie,
      );
      expect([401, 403]).toContain(response.statusCode);
      expect(
        adminAlertSettingsResponseSchema.parse(
          (await get('/api/admin/alert-settings')).json(),
        ),
      ).toMatchObject({ recipients: [], digestMinutes: 15, version: 1 });
    } finally {
      await post(`/api/admin/admins/${fixture.otherAdmin.profileId}/enable`);
    }
  });
});
