import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminApiErrorSchema,
  adminAuditLogsResponseSchema,
  auditLabelActions,
} from '@fs-billing/shared';
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
let fixture: Fixture;
let adminCookie: string;
let otherCookie: string;

const get = (url: string, cookie = adminCookie) =>
  api.inject({ url, headers: requestHeaders(cookie) });
const logs = async (query: string) => {
  const response = await get(`/api/admin/audit-logs?${query}`);
  expect(response.statusCode, response.body).toBe(200);
  return adminAuditLogsResponseSchema.parse(response.json());
};
const beijingToday = () =>
  new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

beforeAll(async () => {
  fixture = await createFixture(connections);
  adminCookie = (await login(api, fixture.admin)).cookie;
  otherCookie = (await login(api, fixture.otherAdmin)).cookie;
});

const edit = (cookie: string, tenantId: string, name: string) =>
  api.inject({
    method: 'POST',
    url: `/api/admin/tenants/${tenantId}/edit`,
    headers: requestHeaders(cookie),
    payload: { name, contactName: '', contactPhone: '', remark: '' },
  });

describe('GET /api/admin/audit-logs', () => {
  it('lists the deletion with its filters', async () => {
    const tenantId = fixture.a.tenantId!;
    // 两个管理员各改一次这个租户；再写一条删除话单的日志（直接以审计载荷写入，删除本身在 cdr-deletion 测试里）。
    expect(
      (await edit(adminCookie, tenantId, 'Renamed by admin')).statusCode,
    ).toBe(200);
    expect(
      (await edit(otherCookie, tenantId, 'Renamed by other')).statusCode,
    ).toBe(200);
    const statementId = randomUUID();
    const auditId = randomUUID();
    await connections.owner.pool.query(
      `insert into operation_logs (id, admin_id, tenant_id, action, target, details)
       values ($1, $2, $3, 'cdr_delete', $4, $5::jsonb)`,
      [
        auditId,
        fixture.admin.profileId,
        tenantId,
        statementId,
        JSON.stringify({
          actor: { id: fixture.admin.profileId, name: 'admin' },
          target: { kind: 'statement', id: statementId },
          content: {
            summary: '删除话单 2026年8月 9,642 条',
            changes: [{ field: 'callCount', before: '9642', after: '0' }],
            month: '2026-08',
            deletedCount: 9642,
          },
        }),
      ],
    );

    const found = await logs(
      `tenantId=${tenantId}&label=cdr_delete&adminId=${fixture.admin.profileId}`,
    );
    expect(found.pagination).toEqual({ page: 1, pageSize: 50, total: 1 });
    expect(found.items).toHaveLength(1);
    expect(found.items[0]).toMatchObject({
      id: auditId,
      actor: { kind: 'admin', id: fixture.admin.profileId, name: 'admin' },
      action: 'cdr_delete',
      label: 'cdr_delete',
      tenant: { id: tenantId, name: 'Renamed by other' },
      target: { kind: 'statement', id: statementId },
      summary: '删除话单 2026年8月 9,642 条',
      changes: [{ field: 'callCount', before: '9642', after: '0' }],
    });
    // 默认范围是最近 30 天，含今天。
    expect(found.range).toEqual({
      from: addDays(beijingToday(), -29),
      to: beijingToday(),
    });

    // 租户 + 操作类型 + 另一个管理员：没有删除。
    expect(
      (
        await logs(
          `tenantId=${tenantId}&label=cdr_delete&adminId=${fixture.otherAdmin.profileId}`,
        )
      ).items,
    ).toEqual([]);
    // 同一租户的修改记录属于「修改租户 / 设置」标签，newest first。
    const edits = await logs(`tenantId=${tenantId}&label=tenant_edit`);
    expect(edits.items.map((item) => item.summary).length).toBe(2);
    expect(edits.items.map((item) => item.actor)).toEqual([
      { kind: 'admin', id: fixture.otherAdmin.profileId, name: 'other-admin' },
      { kind: 'admin', id: fixture.admin.profileId, name: 'admin' },
    ]);
    expect(edits.items.every((item) => item.label === 'tenant_edit')).toBe(
      true,
    );
    expect(edits.items.map((item) => item.occurredAt)).toEqual(
      [...edits.items.map((item) => item.occurredAt)].sort().reverse(),
    );
    // 不带标签看到这个租户的全部（修改 × 2 + 删除）。
    const all = await logs(`tenantId=${tenantId}`);
    expect(all.pagination.total).toBeGreaterThanOrEqual(3);
    for (const item of all.items)
      expect(auditLabelActions[item.label]).toContain(item.action);
  });

  it('filters by day range in Beijing time and pages with 50 rows by default', async () => {
    const tenantId = fixture.a2.tenantId!;
    await connections.owner.pool.query(
      `insert into operation_logs (admin_id, tenant_id, action, target, details, created_at)
       select $1, $2, 'tenant_edit', 'x', '{}'::jsonb, '2026-03-01 16:30:00+00'::timestamptz + g * interval '1 minute'
       from generate_series(0, 54) g`,
      [fixture.admin.profileId, tenantId],
    );
    // 2026-03-01 16:30 UTC 是北京时间 03-02 00:30：整批落在 03-02。
    const day = await logs(
      `tenantId=${tenantId}&from=2026-03-02&to=2026-03-02`,
    );
    expect(day.range).toEqual({ from: '2026-03-02', to: '2026-03-02' });
    expect(day.pagination).toEqual({ page: 1, pageSize: 50, total: 55 });
    expect(day.items).toHaveLength(50);
    const second = await logs(
      `tenantId=${tenantId}&from=2026-03-02&to=2026-03-02&page=2`,
    );
    expect(second.items).toHaveLength(5);
    expect(
      new Set([...day.items, ...second.items].map((item) => item.id)).size,
    ).toBe(55);
    // 前一天与后一天都没有。
    for (const range of [
      'from=2026-03-01&to=2026-03-01',
      'from=2026-03-03&to=2026-03-03',
    ])
      expect(
        (await logs(`tenantId=${tenantId}&${range}`)).pagination.total,
      ).toBe(0);
    // 只给 to：往前 30 天。
    expect((await logs(`tenantId=${tenantId}&to=2026-03-02`)).range).toEqual({
      from: '2026-02-01',
      to: '2026-03-02',
    });
    expect(
      (await logs(`tenantId=${tenantId}&to=2026-03-02`)).pagination.total,
    ).toBe(55);
    // 没有详情的旧记录（details 为空对象）仍然能列出，摘要退回操作名，对象为空。
    expect(day.items[0]).toMatchObject({
      summary: 'tenant_edit',
      target: null,
      changes: [],
    });
  });

  it('shows command line events by their source label, and ignores unknown actions', async () => {
    const label = `cli:auth:bootstrap@probe-${randomUUID()}/ops`;
    const profile = randomUUID();
    await connections.owner.pool.query(
      `insert into operation_logs (admin_id, actor_label, action, target, details)
       values (null, $1, 'credential_bootstrap', $2, $3::jsonb)`,
      [
        label,
        profile,
        JSON.stringify({
          actor: { label },
          target: { kind: 'admin', id: profile },
          content: {
            summary: '创建管理员凭据',
            changes: [],
            mode: 'create',
            result: 'succeeded',
            errorCode: null,
            revokedSessions: 0,
          },
        }),
      ],
    );
    await connections.owner.pool.query(
      `insert into operation_logs (admin_id, action, target) values ($1, 'not_an_audit_action', 'x')`,
      [fixture.admin.profileId],
    );
    const accounts = await logs('label=account&pageSize=100');
    const event = accounts.items.find(
      (item) => item.actor.kind === 'system' && item.actor.label === label,
    );
    expect(event).toMatchObject({
      action: 'credential_bootstrap',
      label: 'account',
      tenant: null,
      target: { kind: 'admin', id: profile },
    });
    expect(
      (await logs('pageSize=100')).items.some(
        (item) => (item.action as string) === 'not_an_audit_action',
      ),
    ).toBe(false);
    // 按管理员筛选看不到没有管理员的事件。
    expect(
      (
        await logs(
          `label=account&adminId=${fixture.admin.profileId}&pageSize=100`,
        )
      ).items.some((item) => item.actor.kind === 'system'),
    ).toBe(false);
  });

  it('is read-only and reading it writes no log', async () => {
    const count = async () =>
      (
        await connections.owner.pool.query<{ n: number }>(
          'select count(*)::int as n from operation_logs',
        )
      ).rows[0]!.n;
    const before = await count();
    await logs('pageSize=100');
    await logs(`label=cdr_delete&tenantId=${fixture.a.tenantId}`);
    expect(await count()).toBe(before);
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const response = await api.inject({
        method,
        url: '/api/admin/audit-logs',
        headers: requestHeaders(adminCookie),
        payload: {},
      });
      expect(response.statusCode, method).toBeGreaterThanOrEqual(400);
      expect(response.statusCode, method).toBeLessThan(500);
    }
    // 表本身也拒绝修改与删除。
    await expect(
      connections.owner.pool.query('delete from operation_logs'),
    ).rejects.toThrow();
    await expect(
      connections.owner.pool.query("update operation_logs set action = 'x'"),
    ).rejects.toThrow();
    expect(await count()).toBe(before);
  });

  it('refuses a reversed range, an unknown label, a bad id and an oversized page', async () => {
    for (const query of [
      'from=2026-09-29&to=2026-08-31',
      'label=nope',
      'adminId=abc',
      'tenantId=abc',
      'from=2026-13-01',
      'pageSize=101',
      'page=0',
      'unknown=1',
    ]) {
      const response = await get(`/api/admin/audit-logs?${query}`);
      expect(response.statusCode, query).toBe(400);
      expect(adminApiErrorSchema.parse(response.json()).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
  });
});
