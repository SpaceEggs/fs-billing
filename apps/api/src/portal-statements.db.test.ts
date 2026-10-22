import { beforeAll, describe, expect, it } from 'vitest';
import { listPortalStatements } from '@fs-billing/db';
import {
  addDecimalStrings,
  apiErrorSchema,
  portalStatementResponseSchema,
  portalStatementsResponseSchema,
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
  backdateTenant,
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
let aCookie: string;
let a2Cookie: string;
let bCookie: string;
let adminCookie: string;

const adminId = () => fixture.admin.profileId;
const current = currentBeijingMonth();
const monthsFrom = (first: string) => {
  const months: string[] = [];
  for (
    let [year, month] = [Number(first.slice(0, 4)), Number(first.slice(5))];
    `${year}-${String(month).padStart(2, '0')}` <= current;
    month === 12 ? ([year, month] = [year + 1, 1]) : (month += 1)
  )
    months.unshift(`${year}-${String(month).padStart(2, '0')}`);
  return months;
};

/** 路由自己决定响应字段；门户 JSON 里不能出现任何内部字段。 */
const internalFields =
  /"(version|generatedBy|reconcile\w*|breakdownGap|tenantId|tenant_id|firstGeneratedAt|regenerable|statementId)"/;

beforeAll(async () => {
  fixture = await createFixture(connections);
  await ensureStatementPartitions(connections);
  const a = fixture.a.tenantId!;
  const a2 = fixture.a2.tenantId!;
  const b = fixture.b.tenantId!;

  await backdateTenant(connections, a, '2026-08-12 09:30:00');
  await statementLedger(
    connections.owner,
    a,
    'recharge',
    '3000',
    '2026-08-12 10:00:00',
    { adminId: adminId() },
  );
  await statementLedger(
    connections.owner,
    a,
    'gift',
    '50',
    '2026-08-12 10:05:00',
    { adminId: adminId() },
  );
  await statementCall(connections.owner, a, {
    answeredAt: '2026-08-15 10:00:00',
    minutes: '3',
    charge: '1.2',
    country: '中国',
  });
  await statementCall(connections.owner, a, {
    answeredAt: '2026-08-20 11:00:00',
    minutes: '5',
    charge: '2.5',
    country: '牙买加',
  });
  await statementLedger(
    connections.owner,
    a,
    'adjustment',
    '-25.5',
    '2026-09-03 09:00:00',
    { adminId: adminId() },
  );
  await statementLedger(
    connections.owner,
    a,
    'credit_recharge',
    '500',
    '2026-09-04 09:00:00',
    { adminId: adminId() },
  );
  await statementCall(connections.owner, a, {
    answeredAt: '2026-09-10 10:00:00',
    minutes: '2',
    charge: '0.8',
    country: '中国',
  });
  await statementCall(connections.owner, a, {
    answeredAt: '2026-09-30 23:59:30',
    minutes: '1',
    charge: '0.3',
    country: '=1+1',
  });
  await statementCdr(connections.owner, a, {
    startedAt: '2026-09-11 12:00:00',
    minutes: '0',
    charge: '0',
  });
  await statementCdr(connections.owner, a, {
    startedAt: '2026-09-12 12:00:00',
    answeredAt: null,
  });
  await generateMonth(connections, a, '2026-08-01');
  await generateMonth(connections, a, '2026-09-01');

  await backdateTenant(connections, a2, '2026-09-05 08:00:00');
  await statementLedger(
    connections.owner,
    a2,
    'recharge',
    '40',
    '2026-09-06 09:00:00',
    { adminId: adminId() },
  );
  await statementCall(connections.owner, a2, {
    answeredAt: '2026-09-07 10:00:00',
    minutes: '2',
    charge: '0.5',
  });

  await backdateTenant(connections, b, '2026-06-05 08:00:00');
  await statementLedger(
    connections.owner,
    b,
    'recharge',
    '10',
    '2026-06-06 09:00:00',
    { adminId: adminId() },
  );
  await generateMonth(connections, b, '2026-06-01');

  aCookie = (await login(api, fixture.a)).cookie;
  a2Cookie = (await login(api, fixture.a2)).cookie;
  bCookie = (await login(api, fixture.b)).cookie;
  adminCookie = (await login(api, fixture.admin)).cookie;
});

describe('GET /api/portal/statements', () => {
  it('lists the tenant months from the first one to the current month, newest first', async () => {
    const response = await api.inject({
      url: '/api/portal/statements',
      headers: requestHeaders(aCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = portalStatementsResponseSchema.parse(response.json());
    expect(body.currency).toBe('CNY');
    expect(body.items.map((item) => item.month)).toEqual(monthsFrom('2026-08'));
    const byMonth = new Map(body.items.map((item) => [item.month, item]));
    expect(byMonth.get('2026-09')).toMatchObject({
      state: 'final',
      detailsDeleted: false,
      figures: {
        openingBalance: '3046.3',
        recharge: '500',
        gift: '0',
        adjustment: '-25.5',
        callCharges: '1.1',
        closingBalance: '3519.7',
        calls: 3,
        callMinutes: '3',
      },
    });
    expect(byMonth.get('2026-08')).toMatchObject({
      state: 'final',
      figures: {
        openingBalance: '0',
        recharge: '3000',
        gift: '50',
        callCharges: '3.7',
        closingBalance: '3046.3',
        calls: 2,
      },
    });
    expect(byMonth.get('2026-09')?.generatedAt).not.toBeNull();
    expect(byMonth.get(current)).toMatchObject({
      state: 'in_progress',
      generatedAt: null,
      detailsDeleted: false,
    });
    // 实时月份的期初是账本里月初前的合计，与上一个月的期末相接。
    const months = body.items.map((item) => item.month);
    const previous = byMonth.get(months[1]!);
    if (previous?.state === 'final')
      expect(byMonth.get(current)?.figures.openingBalance).toBe(
        previous.figures.closingBalance,
      );
    expect(new Date(body.asOf).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('carries no internal fields in the raw JSON', async () => {
    const response = await api.inject({
      url: '/api/portal/statements',
      headers: requestHeaders(aCookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toMatch(internalFields);
    expect(response.body).not.toContain(fixture.a.tenantId);
  });

  it("never shows another tenant's numbers", async () => {
    const response = await api.inject({
      url: '/api/portal/statements',
      headers: requestHeaders(bCookie),
    });
    const body = portalStatementsResponseSchema.parse(response.json());
    expect(body.currency).toBe('USD');
    expect(body.items.map((item) => item.month)).toEqual(monthsFrom('2026-06'));
    expect(response.body).not.toContain('3519.7');
    expect(
      body.items.find((item) => item.month === '2026-06')?.figures,
    ).toMatchObject({
      recharge: '10',
      closingBalance: '10',
    });
  });

  it('lists a month the generator has not reached yet as pending with live figures', async () => {
    const response = await api.inject({
      url: '/api/portal/statements',
      headers: requestHeaders(a2Cookie),
    });
    const body = portalStatementsResponseSchema.parse(response.json());
    expect(body.items.map((item) => item.month)).toEqual(monthsFrom('2026-09'));
    expect(body.items.find((item) => item.month === '2026-09')).toMatchObject({
      state: 'pending',
      generatedAt: null,
      detailsDeleted: false,
      figures: {
        openingBalance: '0',
        recharge: '40',
        callCharges: '0.5',
        closingBalance: '39.5',
        calls: 1,
        callMinutes: '2',
      },
    });
    expect(response.body).not.toMatch(internalFields);
  });

  it('returns only the all-zero current month for a tenant with no activity, from which the empty state is derived', async () => {
    const tenant = await statementTenant(connections.owner);
    const body = await listPortalStatements({
      db: connections.app.db,
      tenantId: tenant.id,
    });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      month: current,
      state: 'in_progress',
      generatedAt: null,
      figures: {
        openingBalance: '0',
        recharge: '0',
        gift: '0',
        adjustment: '0',
        callCharges: '0',
        closingBalance: '0',
        calls: 0,
        callMinutes: '0',
      },
    });
    expect(body.items.some((item) => item.state === 'final')).toBe(false);
  });

  it('rejects a tenant id in the query and anonymous or admin sessions', async () => {
    const attack = await api.inject({
      url: `/api/portal/statements?tenantId=${fixture.b.tenantId}`,
      headers: requestHeaders(aCookie),
    });
    expect(attack.statusCode).toBe(400);
    const anonymous = await api.inject({ url: '/api/portal/statements' });
    expect(anonymous.statusCode).toBe(401);
    const admin = await api.inject({
      url: '/api/portal/statements',
      headers: requestHeaders(adminCookie),
    });
    expect(admin.statusCode).toBe(403);
    expect(apiErrorSchema.parse(admin.json()).error.code).toBe('FORBIDDEN');
  });
});

describe('GET /api/portal/statements/{month}', () => {
  it('returns the stored statement with countries by charge, days and the opening date', async () => {
    const response = await api.inject({
      url: '/api/portal/statements/2026-09',
      headers: requestHeaders(aCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = portalStatementResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      currency: 'CNY',
      tenant: { code: expect.stringMatching(/^A/) as string },
      month: '2026-09',
      state: 'final',
      period: { from: '2026-09-01', to: '2026-09-30', openedOn: null },
      asOf: null,
      detailsDeleted: false,
      figures: { closingBalance: '3519.7', calls: 3 },
    });
    expect(body.countries).toEqual([
      { country: '中国', calls: 2, minutes: '2', charge: '0.8' },
      { country: '=1+1', calls: 1, minutes: '1', charge: '0.3' },
    ]);
    expect(body.days).toEqual([
      { day: '2026-09-10', calls: 1, minutes: '2', charge: '0.8' },
      { day: '2026-09-11', calls: 1, minutes: '0', charge: '0' },
      { day: '2026-09-30', calls: 1, minutes: '1', charge: '0.3' },
    ]);
    expect(response.body).not.toMatch(internalFields);
  });

  it('starts the first month on the opening date', async () => {
    const response = await api.inject({
      url: '/api/portal/statements/2026-08',
      headers: requestHeaders(aCookie),
    });
    const body = portalStatementResponseSchema.parse(response.json());
    expect(body.period).toEqual({
      from: '2026-08-12',
      to: '2026-08-31',
      openedOn: '2026-08-12',
    });
    expect(body.days.map((day) => day.day)).toEqual([
      '2026-08-15',
      '2026-08-20',
    ]);
  });

  it('computes the in-progress month live up to now', async () => {
    const response = await api.inject({
      url: `/api/portal/statements/${current}`,
      headers: requestHeaders(aCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = portalStatementResponseSchema.parse(response.json());
    expect(body.state).toBe('in_progress');
    expect(body.generatedAt).toBeNull();
    expect(body.asOf).not.toBeNull();
    expect(body.period.to).toBe(
      new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10),
    );
    expect(response.body).not.toMatch(internalFields);
  });

  it('computes a month without a statement row as pending, with asOf', async () => {
    const response = await api.inject({
      url: '/api/portal/statements/2026-09',
      headers: requestHeaders(a2Cookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = portalStatementResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      state: 'pending',
      generatedAt: null,
      period: { from: '2026-09-05', to: '2026-09-30', openedOn: '2026-09-05' },
      figures: { recharge: '40', callCharges: '0.5', closingBalance: '39.5' },
      countries: [{ country: '中国', calls: 1, minutes: '2', charge: '0.5' }],
    });
    expect(body.asOf).not.toBeNull();
  });

  it("answers 404 for another tenant's month exactly as for a month that never existed", async () => {
    const other = await api.inject({
      url: '/api/portal/statements/2026-06',
      headers: requestHeaders(aCookie),
    });
    const never = await api.inject({
      url: '/api/portal/statements/2001-01',
      headers: requestHeaders(aCookie),
    });
    expect(other.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
    const strip = (body: string) =>
      Object.entries(apiErrorSchema.parse(JSON.parse(body)).error).filter(
        ([key]) => key !== 'requestId',
      );
    expect(strip(other.body)).toEqual(strip(never.body));
    expect(other.body).not.toContain(fixture.b.tenantId);
    expect(other.body).not.toContain('"10"');
  });

  it('rejects a malformed month, a future month and extra query keys with 400', async () => {
    const next = new Date(Date.now() + 8 * 60 * 60 * 1000);
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    for (const url of [
      '/api/portal/statements/2026-13',
      '/api/portal/statements/2026-9',
      '/api/portal/statements/2026-09-01',
      `/api/portal/statements/${next.toISOString().slice(0, 7)}`,
      '/api/portal/statements/2026-09?tenantId=' + fixture.b.tenantId,
    ]) {
      const response = await api.inject({
        url,
        headers: requestHeaders(aCookie),
      });
      expect(response.statusCode, url).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
  });

  it('marks a month whose call details were deleted without changing the figures', async () => {
    const tenant = fixture.a2.tenantId!;
    await generateMonth(connections, tenant, '2026-09-01');
    await connections.owner.pool.query(
      `update public.monthly_statements set details_deleted = true
       where tenant_id = $1 and month = '2026-09-01'`,
      [tenant],
    );
    const response = await api.inject({
      url: '/api/portal/statements/2026-09',
      headers: requestHeaders(a2Cookie),
    });
    const body = portalStatementResponseSchema.parse(response.json());
    expect(body).toMatchObject({
      state: 'final',
      detailsDeleted: true,
      figures: { recharge: '40', closingBalance: '39.5' },
    });
    const list = portalStatementsResponseSchema.parse(
      (
        await api.inject({
          url: '/api/portal/statements',
          headers: requestHeaders(a2Cookie),
        })
      ).json(),
    );
    expect(
      list.items.find((item) => item.month === '2026-09')?.detailsDeleted,
    ).toBe(true);
  });
});

function csvLines(body: string) {
  expect(body.startsWith('﻿')).toBe(true);
  return body
    .slice(1)
    .split('\r\n')
    .filter((line) => line !== '');
}

describe('POST /api/portal/statements/{month}/export', () => {
  const auditCount = async (tenantId: string) =>
    (
      await connections.owner.pool.query<{ count: number }>(
        'select count(*)::int as count from public.operation_logs where tenant_id = $1',
        [tenantId],
      )
    ).rows[0]!.count;

  it('streams the long-format summary whose signed amounts add up to the closing balance', async () => {
    const before = await auditCount(fixture.a.tenantId!);
    const response = await api.inject({
      method: 'POST',
      url: '/api/portal/statements/2026-09/export',
      headers: requestHeaders(aCookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(
      /^attachment; filename="statement_A[0-9a-f]+_2026-09-01_2026-09-30\.csv"$/,
    );
    const lines = csvLines(response.body);
    expect(lines[0]).toBe('类别,项目,通话数,计费分钟,金额（CNY）');
    expect(lines.slice(1, 7)).toEqual([
      '汇总,期初余额,,,3046.3',
      '汇总,充值,,,500',
      '汇总,赠送,,,0',
      '汇总,调账,,,-25.5',
      '汇总,通话扣费,3,3,-1.1',
      '汇总,期末余额,,,3519.7',
    ]);
    const amounts = lines.slice(1, 7).map((line) => line.split(',')[4]!);
    expect(addDecimalStrings(amounts.slice(0, 5))).toBe(amounts[5]);
    expect(lines.slice(7)).toEqual([
      '国家,中国,2,2,0.8',
      "国家,'=1+1,1,1,0.3",
      '日期,2026-09-10,1,2,0.8',
      '日期,2026-09-11,1,0,0',
      '日期,2026-09-30,1,1,0.3',
    ]);
    expect(response.body).not.toMatch(internalFields);
    // 汇总 CSV 不写操作日志。
    expect(await auditCount(fixture.a.tenantId!)).toBe(before);
  });

  it('exports the live current month and a pending month', async () => {
    for (const [cookie, month] of [
      [aCookie, current],
      [a2Cookie, '2026-09'],
    ] as const) {
      const response = await api.inject({
        method: 'POST',
        url: `/api/portal/statements/${month}/export`,
        headers: requestHeaders(cookie),
      });
      expect(response.statusCode, response.body).toBe(200);
      const lines = csvLines(response.body);
      const amounts = lines.slice(1, 7).map((line) => line.split(',')[4]!);
      expect(addDecimalStrings(amounts.slice(0, 5))).toBe(amounts[5]);
      expect(response.headers['content-disposition']).toContain(
        `_${month}-01_${month}-`,
      );
    }
  });

  it("is the session tenant's file only and 404s for months that are not the tenant's", async () => {
    const own = await api.inject({
      method: 'POST',
      url: '/api/portal/statements/2026-06/export',
      headers: requestHeaders(bCookie),
    });
    expect(own.statusCode).toBe(200);
    expect(csvLines(own.body)[0]).toBe('类别,项目,通话数,计费分钟,金额（USD）');
    expect(own.body).not.toContain('3519.7');
    const other = await api.inject({
      method: 'POST',
      url: '/api/portal/statements/2026-06/export',
      headers: requestHeaders(aCookie),
    });
    expect(other.statusCode).toBe(404);
    expect(other.headers['content-type']).toContain('application/json');
    expect(other.body).not.toContain(',10');
    const future = await api.inject({
      method: 'POST',
      url: '/api/portal/statements/2999-01/export',
      headers: requestHeaders(aCookie),
    });
    expect(future.statusCode).toBe(400);
  });

  it('exports the answered call details of the month, row count equal to the statement call count', async () => {
    const before = await auditCount(fixture.a.tenantId!);
    const response = await api.inject({
      method: 'POST',
      url: '/api/portal/cdrs/export',
      headers: requestHeaders(aCookie),
      payload: { from: '2026-09-01', to: '2026-09-30' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const rows = csvLines(response.body).slice(1);
    const detail = portalStatementResponseSchema.parse(
      (
        await api.inject({
          url: '/api/portal/statements/2026-09',
          headers: requestHeaders(aCookie),
        })
      ).json(),
    );
    expect(detail.figures.calls).toBe(3);
    expect(rows).toHaveLength(detail.figures.calls);
    // 未接通话单不在明细里；零元通话在。
    expect(response.body).not.toContain('未接通');
    expect(response.body).toContain("'=1+1");
    expect(await auditCount(fixture.a.tenantId!)).toBe(before);
  });
});
