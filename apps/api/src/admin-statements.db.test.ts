import { beforeAll, describe, expect, it } from 'vitest';
import {
  addDecimalStrings,
  adminStatementRegenerateResponseSchema,
  adminStatementsResponseSchema,
  adminTenantStatementResponseSchema,
  adminTenantStatementsResponseSchema,
  adminApiErrorSchema,
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
  statementCall,
  statementCdr,
  statementLedger,
  statementTenant,
} from '../test/statements.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
let adminCookie: string;
let customerCookie: string;

const current = currentBeijingMonth();
const adminId = () => fixture.admin.profileId;
const get = (url: string) =>
  api.inject({ url, headers: requestHeaders(adminCookie) });
const post = (url: string, payload?: object) =>
  api.inject({
    method: 'POST',
    url,
    headers: requestHeaders(adminCookie),
    ...(payload ? { payload } : {}),
  });
const regenerate = (tenantId: string, month: string, expectedVersion: number) =>
  post(`/api/admin/tenants/${tenantId}/statements/${month}/regenerate`, {
    expectedVersion,
  });
const errorCode = (body: string) =>
  adminApiErrorSchema.parse(JSON.parse(body)).error.code;

async function auditRows(tenantId: string, action = 'statement_regenerate') {
  const { rows } = await connections.owner.pool.query<{
    id: string;
    admin_id: string;
    tenant_id: string;
    target: string;
    details: {
      actor: { id: string; name: string };
      target: { kind: string; id: string };
      content: Record<string, unknown>;
    };
  }>(
    `select id, admin_id, tenant_id, target, details from public.operation_logs
     where tenant_id = $1 and action = $2 order by created_at, id`,
    [tenantId, action],
  );
  return rows;
}

const header = async (tenantId: string, month: string) =>
  (
    await connections.owner.pool.query<{
      id: string;
      version: number;
      generated_by: string | null;
      reconcile_status: string;
    }>(
      `select id, version, generated_by, reconcile_status from public.monthly_statements
       where tenant_id = $1 and month = $2`,
      [tenantId, `${month}-01`],
    )
  ).rows[0];

/** 8 月有话单与扣费，9 月有话单，两个月都已生成。 */
async function generatedTenant() {
  const tenant = await statementTenant(connections.owner, {
    createdAt: '2026-08-10 08:00:00',
  });
  await statementLedger(
    connections.owner,
    tenant.id,
    'recharge',
    '100',
    '2026-08-10 09:00:00',
    { adminId: adminId() },
  );
  await statementCall(connections.owner, tenant.id, {
    answeredAt: '2026-08-15 10:00:00',
    minutes: '2',
    charge: '1',
  });
  await statementCall(connections.owner, tenant.id, {
    answeredAt: '2026-09-10 10:00:00',
    minutes: '1',
    charge: '0.5',
  });
  await generateMonth(connections, tenant.id, '2026-08-01');
  await generateMonth(connections, tenant.id, '2026-09-01');
  return tenant;
}

beforeAll(async () => {
  fixture = await createFixture(connections);
  await ensureStatementPartitions(connections);
  adminCookie = (await login(api, fixture.admin)).cookie;
  customerCookie = (await login(api, fixture.a)).cookie;
});

describe('GET /api/admin/statements', () => {
  it('groups a month by currency, lists missing statements as pending without figures and totals only final rows', async () => {
    const make = async (
      currency: 'CNY' | 'USD',
      recharge: string,
      generate: boolean,
    ) => {
      const tenant = await statementTenant(connections.owner, {
        createdAt: '2026-06-03 08:00:00',
        currency,
      });
      await statementLedger(
        connections.owner,
        tenant.id,
        'recharge',
        recharge,
        '2026-07-02 09:00:00',
        { adminId: adminId() },
      );
      if (generate) await generateMonth(connections, tenant.id, '2026-07-01');
      return tenant;
    };
    const cny = await make('CNY', '100', true);
    const usd = await make('USD', '20', true);
    const missing = await make('CNY', '5', false);

    const response = await get('/api/admin/statements?month=2026-07');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = adminStatementsResponseSchema.parse(response.json());
    expect(body.month).toBe('2026-07');
    expect(body.groups.map((group) => group.currency)).toEqual(['CNY', 'USD']);
    const [cnyGroup, usdGroup] = body.groups;
    expect(cnyGroup?.tenantCount).toBe(cnyGroup?.items.length);
    const codes = cnyGroup!.items.map((item) => item.tenant.code);
    expect(codes).toEqual([...codes].sort());

    const row = (code: string) =>
      body.groups
        .flatMap((group) => group.items)
        .find((item) => item.tenant.code === code);
    expect(row(cny.code)).toMatchObject({
      state: 'final',
      version: 1,
      reconcileStatus: 'unchecked',
      detailsDeleted: false,
      regenerable: { allowed: true, reason: null },
      figures: { openingBalance: '0', recharge: '100', closingBalance: '100' },
    });
    expect(row(usd.code)?.figures?.recharge).toBe('20');
    expect(row(missing.code)).toMatchObject({
      state: 'pending',
      figures: null,
      generatedAt: null,
      firstGeneratedAt: null,
      version: 0,
      reconcileStatus: null,
      regenerable: { allowed: true, reason: null },
    });
    // 合计只算 final 行，且每个币种各算各的。
    for (const group of body.groups) {
      const finals = group.items.flatMap((item) =>
        item.state === 'final' && item.figures ? [item.figures] : [],
      );
      expect(group.totals.recharge).toBe(
        addDecimalStrings(finals.map((figures) => figures.recharge)),
      );
      expect(group.totals.closingBalance).toBe(
        addDecimalStrings(finals.map((figures) => figures.closingBalance)),
      );
      expect(group.totals.calls).toBe(
        finals.reduce((sum, figures) => sum + figures.calls, 0),
      );
    }
    expect(usdGroup?.items.some((item) => item.tenant.code === cny.code)).toBe(
      false,
    );
    expect(cnyGroup?.totals.recharge).not.toBe(
      addDecimalStrings([cnyGroup!.totals.recharge, '5']),
    );
  });

  it('exposes stale and inconsistent reconcile states in the list and the detail', async () => {
    const tenant = await generatedTenant();
    await connections.owner.pool.query(
      `update public.monthly_statements
       set reconcile_status = 'stale', reconciled_at = now(), reconcile_diff = '-2'
       where tenant_id = $1 and month = '2026-09-01'`,
      [tenant.id],
    );
    await connections.owner.pool.query(
      `update public.monthly_statements
       set reconcile_status = 'inconsistent', reconciled_at = now(), reconcile_diff = '3'
       where tenant_id = $1 and month = '2026-08-01'`,
      [tenant.id],
    );
    const list = adminStatementsResponseSchema.parse(
      (await get('/api/admin/statements?month=2026-09')).json(),
    );
    expect(
      list.groups
        .flatMap((group) => group.items)
        .find((item) => item.tenant.id === tenant.id)?.reconcileStatus,
    ).toBe('stale');
    const detail = adminTenantStatementResponseSchema.parse(
      (await get(`/api/admin/tenants/${tenant.id}/statements/2026-08`)).json(),
    );
    expect(detail.reconcile).toMatchObject({
      status: 'inconsistent',
      diff: '3',
    });
    const tab = adminTenantStatementsResponseSchema.parse(
      (await get(`/api/admin/tenants/${tenant.id}/statements`)).json(),
    );
    expect(
      Object.fromEntries(
        tab.items.map((item) => [item.month, item.reconcileStatus]),
      ),
    ).toMatchObject({ '2026-09': 'stale', '2026-08': 'inconsistent' });
  });

  it('defaults to the previous Beijing month, is empty for the current month and rejects a future month', async () => {
    const previous = new Date(Date.now() + 8 * 60 * 60 * 1000);
    previous.setUTCMonth(previous.getUTCMonth() - 1, 1);
    const defaulted = adminStatementsResponseSchema.parse(
      (await get('/api/admin/statements')).json(),
    );
    expect(defaulted.month).toBe(previous.toISOString().slice(0, 7));
    const now = adminStatementsResponseSchema.parse(
      (await get(`/api/admin/statements?month=${current}`)).json(),
    );
    expect(now.groups).toEqual([]);
    for (const query of ['month=2999-01', 'month=2026-13', 'month=2026-07&x=1'])
      expect(
        (await get(`/api/admin/statements?${query}`)).statusCode,
        query,
      ).toBe(400);
  });
});

describe('admin tenant statements', () => {
  it('lists every month with live pending figures and the regenerable reason', async () => {
    const tenant = await statementTenant(connections.owner, {
      createdAt: '2026-08-10 08:00:00',
    });
    await statementLedger(
      connections.owner,
      tenant.id,
      'recharge',
      '100',
      '2026-08-10 09:00:00',
      {
        adminId: adminId(),
      },
    );
    await statementCall(connections.owner, tenant.id, {
      answeredAt: '2026-08-15 10:00:00',
      charge: '1',
    });
    await generateMonth(connections, tenant.id, '2026-08-01');
    await connections.owner.pool.query(
      `update public.monthly_statements set details_deleted = true
       where tenant_id = $1 and month = '2026-08-01'`,
      [tenant.id],
    );
    const response = await get(`/api/admin/tenants/${tenant.id}/statements`);
    expect(response.statusCode, response.body).toBe(200);
    const body = adminTenantStatementsResponseSchema.parse(response.json());
    expect(body.tenant).toMatchObject({ id: tenant.id, code: tenant.code });
    const months = body.items.map((item) => item.month);
    expect(months[0]).toBe(current);
    expect(months.at(-1)).toBe('2026-08');
    const byMonth = new Map(body.items.map((item) => [item.month, item]));
    expect(byMonth.get(current)).toMatchObject({
      state: 'in_progress',
      version: 0,
      regenerable: { allowed: false, reason: 'in_progress' },
    });
    expect(byMonth.get('2026-08')).toMatchObject({
      state: 'final',
      detailsDeleted: true,
      regenerable: { allowed: false, reason: 'details_deleted' },
    });
    if (current > '2026-09')
      expect(byMonth.get('2026-09')).toMatchObject({
        state: 'pending',
        figures: { openingBalance: '99', closingBalance: '99' },
        regenerable: { allowed: true, reason: null },
      });
  });

  it('shows version, generator, reconcile result and breakdown gap in the detail', async () => {
    const tenant = await generatedTenant();
    const scheduled = adminTenantStatementResponseSchema.parse(
      (await get(`/api/admin/tenants/${tenant.id}/statements/2026-08`)).json(),
    );
    expect(scheduled).toMatchObject({
      state: 'final',
      version: 1,
      generatedBy: null,
      breakdownGap: '0',
      reconcile: { status: 'unchecked', reconciledAt: null, diff: null },
      regenerable: { allowed: true, reason: null },
      period: { from: '2026-08-10', to: '2026-08-31', openedOn: '2026-08-10' },
    });
    expect(scheduled.firstGeneratedAt).toBe(scheduled.generatedAt);
    const live = adminTenantStatementResponseSchema.parse(
      (
        await get(`/api/admin/tenants/${tenant.id}/statements/${current}`)
      ).json(),
    );
    expect(live).toMatchObject({
      state: 'in_progress',
      version: 0,
      reconcile: null,
      generatedBy: null,
      regenerable: { allowed: false, reason: 'in_progress' },
    });
    expect(live.asOf).not.toBeNull();
  });

  it('answers 404 for an unknown tenant or a month before the first one, and 400 for a future month', async () => {
    const tenant = await generatedTenant();
    const unknown = '11111111-1111-4111-8111-111111111111';
    for (const url of [
      `/api/admin/tenants/${unknown}/statements`,
      `/api/admin/tenants/${unknown}/statements/2026-09`,
      `/api/admin/tenants/${tenant.id}/statements/2026-07`,
    ])
      expect((await get(url)).statusCode, url).toBe(404);
    for (const url of [
      `/api/admin/tenants/${tenant.id}/statements/2999-01`,
      `/api/admin/tenants/${tenant.id}/statements/2026-9`,
    ])
      expect((await get(url)).statusCode, url).toBe(400);
  });

  it('exports the summary CSV that sums to the closing balance without an audit row, and the answered detail CSV with the cdr_export audit', async () => {
    const tenant = await generatedTenant();
    await statementCdr(connections.owner, tenant.id, {
      startedAt: '2026-09-12 12:00:00',
      answeredAt: null,
    });
    const before = await auditRows(tenant.id, 'statement_regenerate');
    const exportsBefore = await auditRows(tenant.id, 'cdr_export');
    const summary = await post(
      `/api/admin/tenants/${tenant.id}/statements/2026-09/export`,
    );
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.headers['content-disposition']).toBe(
      `attachment; filename="statement_${tenant.code}_2026-09-01_2026-09-30.csv"`,
    );
    const lines = summary.body.slice(1).split('\r\n').filter(Boolean);
    expect(lines[0]).toBe('类别,项目,通话数,计费分钟,金额（CNY）');
    const amounts = lines.slice(1, 7).map((line) => line.split(',')[4]!);
    expect(amounts).toEqual(['99', '0', '0', '0', '-0.5', '98.5']);
    expect(addDecimalStrings(amounts.slice(0, 5))).toBe(amounts[5]);
    expect(await auditRows(tenant.id)).toHaveLength(before.length);
    expect(await auditRows(tenant.id, 'cdr_export')).toHaveLength(
      exportsBefore.length,
    );

    const detail = await post(`/api/admin/tenants/${tenant.id}/cdrs/export`, {
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(detail.statusCode, detail.body).toBe(200);
    const rows = detail.body.slice(1).split('\r\n').filter(Boolean).slice(1);
    expect(rows).toHaveLength(1);
    expect(detail.body).not.toContain('未接通');
    const exports = await auditRows(tenant.id, 'cdr_export');
    expect(exports).toHaveLength(exportsBefore.length + 1);
    expect(exports.at(-1)?.details.content).toMatchObject({ rowCount: 1 });
  });

  it('keeps every statement operation away from customer sessions', async () => {
    const tenant = await generatedTenant();
    const base = `/api/admin/tenants/${tenant.id}`;
    for (const [method, url, payload] of [
      ['GET', '/api/admin/statements', undefined],
      ['GET', `${base}/statements`, undefined],
      ['GET', `${base}/statements/2026-09`, undefined],
      ['POST', `${base}/statements/2026-09/export`, undefined],
      ['POST', `${base}/statements/2026-09/regenerate`, { expectedVersion: 1 }],
    ] as const) {
      const response = await api.inject({
        method,
        url,
        headers: requestHeaders(customerCookie),
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, url).toBe(403);
      expect(errorCode(response.body)).toBe('FORBIDDEN');
    }
    expect((await header(tenant.id, '2026-09'))?.version).toBe(1);
  });
});

describe('POST /api/admin/tenants/{tenantId}/statements/{month}/regenerate', () => {
  it('regenerates and writes one statement_regenerate audit with before and after, and lists the stale following months', async () => {
    const tenant = await generatedTenant();
    // 补推：8 月的一通电话，扣费在此刻才写入。
    await statementCall(connections.owner, tenant.id, {
      answeredAt: '2026-08-20 10:00:00',
      minutes: '4',
      charge: '2',
      ledgerCreatedAt: 'now',
    });
    const before = await header(tenant.id, '2026-08');
    const response = await regenerate(tenant.id, '2026-08', 1);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = adminStatementRegenerateResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      month: '2026-08',
      created: false,
      changed: true,
      before: {
        version: 1,
        callCharges: '1',
        closingBalance: '99',
        calls: 1,
        callMinutes: '2',
      },
      after: {
        version: 2,
        callCharges: '3',
        closingBalance: '97',
        calls: 2,
        callMinutes: '6',
      },
      staleFollowingMonths: ['2026-09'],
    });

    const audits = await auditRows(tenant.id);
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    expect(audit).toMatchObject({
      id: body.auditId,
      admin_id: adminId(),
      tenant_id: tenant.id,
      target: before?.id,
    });
    expect(audit?.details).toMatchObject({
      actor: { id: adminId() },
      target: { kind: 'statement', id: before?.id },
      content: {
        month: '2026-08',
        created: false,
        changed: true,
        before: body.before,
        after: body.after,
        changes: [],
      },
    });
    expect(audit?.details.content.summary).toContain(tenant.code);
    const stored = await header(tenant.id, '2026-08');
    expect(stored).toMatchObject({
      version: 2,
      generated_by: adminId(),
      reconcile_status: 'unchecked',
    });
    const detail = adminTenantStatementResponseSchema.parse(
      (await get(`/api/admin/tenants/${tenant.id}/statements/2026-08`)).json(),
    );
    expect(detail.generatedBy).toEqual({ id: adminId(), name: 'admin' });
    expect(detail.version).toBe(2);
    expect(detail.firstGeneratedAt).not.toBe(detail.generatedAt);

    // 不级联：9 月原样，仍提示过期；按月份顺序重新生成 9 月后不再提示。
    expect((await header(tenant.id, '2026-09'))?.version).toBe(1);
    const next = adminStatementRegenerateResponseSchema.parse(
      (await regenerate(tenant.id, '2026-09', 1)).json(),
    );
    expect(next).toMatchObject({ changed: true, staleFollowingMonths: [] });
    expect(next.after.openingBalance).toBe('97');
  });

  it('records a no-op as unchanged: no new version, still one audit row', async () => {
    const tenant = await generatedTenant();
    const response = await regenerate(tenant.id, '2026-09', 1);
    expect(response.statusCode, response.body).toBe(200);
    const body = adminStatementRegenerateResponseSchema.parse(response.json());
    expect(body).toMatchObject({ changed: false, created: false });
    expect(body.before).toEqual(body.after);
    expect(body.after.version).toBe(1);
    expect((await header(tenant.id, '2026-09'))?.version).toBe(1);
    const audits = await auditRows(tenant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details.content).toMatchObject({ changed: false });
    expect(audits[0]?.id).toBe(body.auditId);
  });

  it('rejects a stale expectedVersion with STATEMENT_VERSION_CONFLICT and writes no audit', async () => {
    const tenant = await generatedTenant();
    await statementCall(connections.owner, tenant.id, {
      answeredAt: '2026-09-11 10:00:00',
      charge: '1',
      ledgerCreatedAt: 'now',
    });
    expect((await regenerate(tenant.id, '2026-09', 1)).statusCode).toBe(200);
    const stale = await regenerate(tenant.id, '2026-09', 1);
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorCode(stale.body)).toBe('STATEMENT_VERSION_CONFLICT');
    expect(await auditRows(tenant.id)).toHaveLength(1);
    expect((await header(tenant.id, '2026-09'))?.version).toBe(2);
  });

  it('lets exactly one of two concurrent regenerations with the same expectedVersion win', async () => {
    const tenant = await generatedTenant();
    await statementCall(connections.owner, tenant.id, {
      answeredAt: '2026-09-12 10:00:00',
      charge: '1',
      ledgerCreatedAt: 'now',
    });
    const results = await Promise.all([
      regenerate(tenant.id, '2026-09', 1),
      regenerate(tenant.id, '2026-09', 1),
    ]);
    expect(results.map((result) => result.statusCode).sort()).toEqual([
      200, 409,
    ]);
    const loser = results.find((result) => result.statusCode === 409);
    expect(errorCode(loser!.body)).toBe('STATEMENT_VERSION_CONFLICT');
    expect(await auditRows(tenant.id)).toHaveLength(1);
    expect((await header(tenant.id, '2026-09'))?.version).toBe(2);
  });

  it('rejects a month whose call details were deleted with STATEMENT_DETAILS_DELETED', async () => {
    const tenant = await generatedTenant();
    await connections.owner.pool.query(
      `update public.monthly_statements set details_deleted = true
       where tenant_id = $1 and month = '2026-09-01'`,
      [tenant.id],
    );
    const response = await regenerate(tenant.id, '2026-09', 1);
    expect(response.statusCode, response.body).toBe(409);
    expect(errorCode(response.body)).toBe('STATEMENT_DETAILS_DELETED');
    expect(await auditRows(tenant.id)).toHaveLength(0);
    const detail = adminTenantStatementResponseSchema.parse(
      (await get(`/api/admin/tenants/${tenant.id}/statements/2026-09`)).json(),
    );
    expect(detail).toMatchObject({
      detailsDeleted: true,
      regenerable: { allowed: false, reason: 'details_deleted' },
    });
  });

  it('rejects the in-progress month with STATEMENT_NOT_FINAL', async () => {
    const tenant = await generatedTenant();
    const response = await regenerate(tenant.id, current, 0);
    expect(response.statusCode, response.body).toBe(409);
    expect(errorCode(response.body)).toBe('STATEMENT_NOT_FINAL');
    expect(await auditRows(tenant.id)).toHaveLength(0);
  });

  it('backfills a pending month as version 1 with expectedVersion 0 and a null before', async () => {
    const tenant = await statementTenant(connections.owner, {
      createdAt: '2026-08-10 08:00:00',
    });
    await statementLedger(
      connections.owner,
      tenant.id,
      'recharge',
      '50',
      '2026-08-11 09:00:00',
      {
        adminId: adminId(),
      },
    );
    await statementCall(connections.owner, tenant.id, {
      answeredAt: '2026-08-12 10:00:00',
      charge: '0.5',
    });
    const conflict = await regenerate(tenant.id, '2026-08', 1);
    expect(conflict.statusCode).toBe(409);
    expect(errorCode(conflict.body)).toBe('STATEMENT_VERSION_CONFLICT');
    const response = await regenerate(tenant.id, '2026-08', 0);
    expect(response.statusCode, response.body).toBe(200);
    const body = adminStatementRegenerateResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      created: true,
      changed: true,
      before: null,
      after: {
        version: 1,
        recharge: '50',
        callCharges: '0.5',
        closingBalance: '49.5',
      },
    });
    const audits = await auditRows(tenant.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details.content).toMatchObject({
      created: true,
      before: null,
    });
    expect((await header(tenant.id, '2026-08'))?.version).toBe(1);
  });

  it('answers 404 for an unknown tenant or a month before the first one and 400 for invalid input', async () => {
    const tenant = await generatedTenant();
    expect(
      (await regenerate('11111111-1111-4111-8111-111111111111', '2026-09', 1))
        .statusCode,
    ).toBe(404);
    expect((await regenerate(tenant.id, '2026-07', 0)).statusCode).toBe(404);
    expect((await regenerate(tenant.id, '2999-01', 0)).statusCode).toBe(400);
    for (const payload of [
      {},
      { expectedVersion: -1 },
      { expectedVersion: '1' },
      { expectedVersion: 1, statementId: fixture.admin.profileId },
    ]) {
      const response = await post(
        `/api/admin/tenants/${tenant.id}/statements/2026-09/regenerate`,
        payload,
      );
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await auditRows(tenant.id)).toHaveLength(0);
  });
});
