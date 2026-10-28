import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  adminApiErrorSchema,
  adminCdrDeleteResponseSchema,
  adminCdrDeletionMonthsResponseSchema,
  adminCdrsResponseSchema,
  adminAuditLogsResponseSchema,
} from '@fs-billing/shared';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';
import {
  currentBeijingMonth,
  ensureStatementPartitions,
  generateMonth,
  statementLedger,
  statementTenant,
} from '../test/statements.js';
import { chargedCall } from '../test/unassigned.js';
import { withSystem, reconcileTenantStatements } from '@fs-billing/db';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let adminCookie: string;

const get = (url: string) =>
  api.inject({ url, headers: requestHeaders(adminCookie) });
const post = (url: string, payload: object) =>
  api.inject({
    method: 'POST',
    url,
    headers: requestHeaders(adminCookie),
    payload,
  });
const errorCode = (body: string) =>
  adminApiErrorSchema.parse(JSON.parse(body)).error.code;
const one = async <T extends object>(text: string, values: unknown[] = []) =>
  (await connections.owner.pool.query<T>(text, values)).rows[0]!;

beforeAll(async () => {
  fixture = await createFixture(connections);
  await ensureStatementPartitions(connections);
  adminCookie = (await login(api, fixture.admin)).cookie;
});

/** 8-12 开户的租户：8 月三通、9 月两通，账单已生成并核对为 ok（和数据库层测试同形）。 */
async function deletableTenant() {
  const tenant = await statementTenant(connections.owner, {
    createdAt: '2026-08-12 09:30:00',
  });
  await statementLedger(
    connections.owner,
    tenant.id,
    'recharge',
    '100',
    '2026-08-12 10:00:00',
    { adminId: fixture.admin.profileId },
  );
  for (const answeredAt of [
    '2026-08-15 10:00:00',
    '2026-08-20 11:00:00',
    '2026-08-31 23:59:55',
    '2026-09-05 10:00:00',
    '2026-09-25 10:00:00',
  ])
    await chargedCall(connections.owner, tenant.id, { answeredAt });
  for (const month of ['2026-08-01', '2026-09-01'])
    await generateMonth(connections, tenant.id, month);
  await withSystem(
    connections.app.db,
    (tx) => reconcileTenantStatements(tx, tenant.id),
    { isolationLevel: 'repeatable read' },
  );
  return tenant;
}
const deleteBody = (
  tenant: { code: string },
  overrides: Record<string, unknown> = {},
) => ({
  fromMonth: '2026-08',
  toMonth: '2026-08',
  tenantCode: tenant.code,
  expectedCount: 3,
  ...overrides,
});
const ledgerFingerprint = (tenantId: string) =>
  one<{ entries: number; balance: string; digest: string }>(
    `select count(*)::int as entries,
       (select balance::text from tenant_balances where tenant_id = $1) as balance,
       md5(string_agg(id::text || amount::text || occurred_at::text, ',' order by id)) as digest
     from ledger_entries where tenant_id = $1`,
    [tenantId],
  );
const auditRows = async (tenantId: string) =>
  (
    await connections.owner.pool.query<{
      id: string;
      admin_id: string;
      created_at: Date;
      details: {
        actor: { id: string; name: string };
        target: { kind: string; id: string };
        content: Record<string, unknown>;
      };
    }>(
      `select id,admin_id,created_at,details from operation_logs
       where tenant_id = $1 and action = 'cdr_delete' order by created_at,id`,
      [tenantId],
    )
  ).rows;

describe('GET /api/admin/tenants/{tenantId}/cdr-deletions', () => {
  it('shows twelve months with their state and the count of each deletable one', async () => {
    const tenant = await deletableTenant();
    const response = await get(
      `/api/admin/tenants/${tenant.id}/cdr-deletions?year=2026`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const body = adminCdrDeletionMonthsResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      tenant: { id: tenant.id, code: tenant.code },
      year: 2026,
    });
    const byMonth = new Map(body.months.map((month) => [month.month, month]));
    expect(byMonth.get('2026-08')).toMatchObject({
      state: 'deletable',
      cdrCount: 3,
      blockedReasons: [],
      deleted: null,
    });
    expect(byMonth.get('2026-09')).toMatchObject({
      state: 'deletable',
      cdrCount: 2,
    });
    expect(byMonth.get('2026-07')).toMatchObject({
      state: 'before_opening',
      cdrCount: null,
    });
    // 当前月没有账单，不可选。
    const current = currentBeijingMonth();
    if (current.startsWith('2026'))
      expect(byMonth.get(current)).toMatchObject({ state: 'no_statement' });
    expect(body.months.map((month) => month.month)).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `2026-${String(i + 1).padStart(2, '0')}`,
      ),
    );
  });

  it('marks a month blocked while a charge is missing or the reconciliation did not pass', async () => {
    const tenant = await deletableTenant();
    await chargedCall(connections.owner, tenant.id, {
      answeredAt: '2026-08-25 10:00:00',
      ledger: false,
    });
    const body = adminCdrDeletionMonthsResponseSchema.parse(
      (
        await get(`/api/admin/tenants/${tenant.id}/cdr-deletions?year=2026`)
      ).json(),
    );
    expect(
      body.months.find((month) => month.month === '2026-08'),
    ).toMatchObject({
      state: 'blocked',
      cdrCount: 4,
      blockedReasons: expect.arrayContaining(['uncharged_calls']) as string[],
    });
  });

  it('refuses a missing or invalid year and answers 404 for an unknown tenant', async () => {
    const tenant = await deletableTenant();
    for (const query of ['', '?year=0', '?year=10000', '?year=abc'])
      expect(
        (await get(`/api/admin/tenants/${tenant.id}/cdr-deletions${query}`))
          .statusCode,
        query,
      ).toBe(400);
    expect(
      (await get(`/api/admin/tenants/${randomUUID()}/cdr-deletions?year=2026`))
        .statusCode,
    ).toBe(404);
  });
});

describe('POST /api/admin/tenants/{tenantId}/cdr-deletions', () => {
  it('rejects the current month, a month without a statement, a wrong code and a changed count', async () => {
    const tenant = await deletableTenant();
    const url = `/api/admin/tenants/${tenant.id}/cdr-deletions`;
    const before = await ledgerFingerprint(tenant.id);

    const current = currentBeijingMonth();
    const now = await post(
      url,
      deleteBody(tenant, {
        fromMonth: current,
        toMonth: current,
        expectedCount: 0,
      }),
    );
    expect(now.statusCode, now.body).toBe(409);
    expect(errorCode(now.body)).toBe('CDR_MONTH_NOT_DELETABLE');

    // 开始月份晚于结束月份是 400；范围里只要有一个月不可删，一条都不删。
    const reversed = await post(
      url,
      deleteBody(tenant, {
        fromMonth: '2026-08',
        toMonth: '2026-07',
        expectedCount: 3,
      }),
    );
    expect(reversed.statusCode).toBe(400);
    const beforeOpening = await post(
      url,
      deleteBody(tenant, {
        fromMonth: '2026-07',
        toMonth: '2026-08',
        expectedCount: 3,
      }),
    );
    expect(beforeOpening.statusCode).toBe(409);
    expect(errorCode(beforeOpening.body)).toBe('CDR_MONTH_NOT_DELETABLE');

    const wrongCode = await post(
      url,
      deleteBody(tenant, { tenantCode: tenant.code.toLowerCase() }),
    );
    expect(wrongCode.statusCode).toBe(400);
    expect(errorCode(wrongCode.body)).toBe('VALIDATION_ERROR');

    const stale = await post(url, deleteBody(tenant, { expectedCount: 4 }));
    expect(stale.statusCode).toBe(409);
    expect(errorCode(stale.body)).toBe('CDR_DELETE_COUNT_CHANGED');

    // 什么都没删：话单、标志、日志、流水都没变。
    const months = adminCdrDeletionMonthsResponseSchema.parse(
      (await get(`${url}?year=2026`)).json(),
    );
    expect(
      months.months.find((month) => month.month === '2026-08'),
    ).toMatchObject({ state: 'deletable', cdrCount: 3 });
    expect(await auditRows(tenant.id)).toEqual([]);
    expect(await ledgerFingerprint(tenant.id)).toEqual(before);
    expect(
      (
        await post(
          url,
          deleteBody(tenant, { fromMonth: '2026-8', toMonth: '2026-08' }),
        )
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post(
          `/api/admin/tenants/${randomUUID()}/cdr-deletions`,
          deleteBody(tenant),
        )
      ).statusCode,
    ).toBe(404);
  });

  it('deletes August: the ledger is untouched, the audit names who, when, which tenant, month and count', async () => {
    const tenant = await deletableTenant();
    const url = `/api/admin/tenants/${tenant.id}/cdr-deletions`;
    const before = await ledgerFingerprint(tenant.id);
    const response = await post(url, deleteBody(tenant));
    expect(response.statusCode, response.body).toBe(200);
    const result = adminCdrDeleteResponseSchema.parse(response.json());
    expect(result).toMatchObject({
      months: [{ month: '2026-08', deleted: 3 }],
      total: 3,
      remaining: [],
      failure: null,
    });
    // 删除后流水与余额不变，9 月的话单还在。
    expect(await ledgerFingerprint(tenant.id)).toEqual(before);
    expect(
      (
        await one<{ n: number }>(
          'select count(*)::int as n from cdrs where tenant_id = $1',
          [tenant.id],
        )
      ).n,
    ).toBe(2);

    const [audit, ...rest] = await auditRows(tenant.id);
    expect(rest).toEqual([]);
    expect(audit).toMatchObject({
      id: result.months[0]!.auditId,
      admin_id: fixture.admin.profileId,
      details: {
        actor: { id: fixture.admin.profileId, name: 'admin' },
        target: { kind: 'statement', id: result.months[0]!.statementId },
        content: {
          month: '2026-08',
          deletedCount: 3,
          confirmedCode: tenant.code,
          range: { from: '2026-08-12', to: '2026-08-31' },
          changes: [{ field: 'callCount', before: '3', after: '0' }],
        },
      },
    });

    // 月份格：8 月已删除并带上操作人，9 月仍可删。
    const months = adminCdrDeletionMonthsResponseSchema.parse(
      (await get(`${url}?year=2026`)).json(),
    );
    expect(
      months.months.find((month) => month.month === '2026-08'),
    ).toMatchObject({
      state: 'deleted',
      cdrCount: 3,
      deleted: {
        by: { id: fixture.admin.profileId, name: 'admin' },
        at: expect.any(String) as string,
      },
    });
    expect(
      months.months.find((month) => month.month === '2026-09'),
    ).toMatchObject({
      state: 'deletable',
      cdrCount: 2,
    });

    // 话单页：范围含 8 月时带提示条的数据，不含时为空。
    const cdrs = async (from: string, to: string) =>
      adminCdrsResponseSchema.parse(
        (
          await get(
            `/api/admin/tenants/${tenant.id}/cdrs?from=${from}&to=${to}&status=all`,
          )
        ).json(),
      );
    expect((await cdrs('2026-08-01', '2026-08-31')).deletedMonths).toEqual([
      {
        month: '2026-08',
        count: 3,
        deletedBy: { id: fixture.admin.profileId, name: 'admin' },
        deletedAt: expect.any(String) as string,
      },
    ]);
    expect((await cdrs('2026-08-20', '2026-09-10')).deletedMonths).toHaveLength(
      1,
    );
    expect((await cdrs('2026-09-01', '2026-09-30')).deletedMonths).toEqual([]);

    // 同一个月再删：409。
    const again = await post(url, deleteBody(tenant, { expectedCount: 0 }));
    expect(again.statusCode).toBe(409);
    expect(errorCode(again.body)).toBe('CDR_MONTH_NOT_DELETABLE');
  });

  it('writes one cdr_delete entry per month and finds them through the log endpoint', async () => {
    const tenant = await deletableTenant();
    const response = await post(
      `/api/admin/tenants/${tenant.id}/cdr-deletions`,
      deleteBody(tenant, { toMonth: '2026-09', expectedCount: 5 }),
    );
    expect(response.statusCode, response.body).toBe(200);
    const result = adminCdrDeleteResponseSchema.parse(response.json());
    expect(result.months.map((month) => [month.month, month.deleted])).toEqual([
      ['2026-08', 3],
      ['2026-09', 2],
    ]);
    const rows = await auditRows(tenant.id);
    expect(rows.map((row) => row.details.content['month'])).toEqual([
      '2026-08',
      '2026-09',
    ]);
    const logs = adminAuditLogsResponseSchema.parse(
      (
        await get(
          `/api/admin/audit-logs?tenantId=${tenant.id}&label=cdr_delete&adminId=${fixture.admin.profileId}`,
        )
      ).json(),
    );
    expect(logs.pagination.total).toBe(2);
    expect(logs.items.map((item) => item.id).sort()).toEqual(
      result.months.map((month) => month.auditId).sort(),
    );
  });

  it('reports a partial deletion: finished months stay, the response lists the rest and hides the failure detail', async () => {
    const tenant = await deletableTenant();
    const name = `cdr_delete_failure_${randomUUID().replaceAll('-', '')}`;
    // 9 月置标志时数据库报错：8 月已提交，9 月整体回滚。
    await connections.owner.pool.query(
      `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${tenant.id}' AND NEW.month='2026-09-01' AND NEW.details_deleted AND NOT OLD.details_deleted THEN RAISE EXCEPTION 'Injected secret-looking failure'; END IF; RETURN NEW; END $$`,
    );
    let response;
    try {
      await connections.owner.pool.query(
        `CREATE TRIGGER ${name} BEFORE UPDATE ON public.monthly_statements FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
      );
      response = await post(
        `/api/admin/tenants/${tenant.id}/cdr-deletions`,
        deleteBody(tenant, { toMonth: '2026-09', expectedCount: 5 }),
      );
    } finally {
      await connections.owner.pool.query(
        `DROP TRIGGER IF EXISTS ${name} ON public.monthly_statements`,
      );
      await connections.owner.pool.query(`DROP FUNCTION public.${name}()`);
    }
    expect(response.statusCode, response.body).toBe(200);
    const result = adminCdrDeleteResponseSchema.parse(response.json());
    expect(result).toMatchObject({
      months: [{ month: '2026-08', deleted: 3 }],
      total: 3,
      remaining: ['2026-09'],
      failure: { month: '2026-09', code: 'INTERNAL' },
    });
    expect(response.body).not.toContain('secret-looking');
    expect(await auditRows(tenant.id)).toHaveLength(1);
    expect(
      (
        await one<{ n: number }>(
          'select count(*)::int as n from cdrs where tenant_id = $1',
          [tenant.id],
        )
      ).n,
    ).toBe(2);

    // 重试只处理剩余月份。
    const retry = await post(
      `/api/admin/tenants/${tenant.id}/cdr-deletions`,
      deleteBody(tenant, {
        fromMonth: '2026-09',
        toMonth: '2026-09',
        expectedCount: 2,
      }),
    );
    expect(retry.statusCode, retry.body).toBe(200);
    expect(adminCdrDeleteResponseSchema.parse(retry.json())).toMatchObject({
      months: [{ month: '2026-09', deleted: 2 }],
      remaining: [],
      failure: null,
    });
  });
});
