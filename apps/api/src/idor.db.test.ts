import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  appendLedgerEntry,
  ensureCdrPartitions,
  schema,
  withAdmin,
  withTenant,
} from '@fs-billing/db';
import { money } from '@fs-billing/rating';
import {
  apiErrorSchema,
  portalContextResponseSchema,
  portalCdrsResponseSchema,
  portalHomeResponseSchema,
  cdrCountriesResponseSchema,
  portalLedgerResponseSchema,
  portalStatementResponseSchema,
  portalStatementsResponseSchema,
  sessionResponseSchema,
} from '@fs-billing/shared';
import { generateOpenApi } from './openapi.js';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  password,
  requestHeaders,
  type Fixture,
} from '../test/support.js';
import {
  backdateTenant,
  currentBeijingMonth,
  ensureStatementPartitions,
  generateMonth,
  statementLedger,
} from '../test/statements.js';

const connections = apiConnections();
const laneSchema = z.enum(['app', 'owner']);
const lanes = process.env.P4_IDOR_LANE
  ? [laneSchema.parse(process.env.P4_IDOR_LANE)]
  : laneSchema.options;
const discovery = fixtureApi(connections);
const { document, operations } = await generateOpenApi(discovery.api);
const customerOperations = operations.filter((operation) =>
  ['session', 'authenticated', 'customer'].includes(operation['x-access']),
);
type Operation = (typeof customerOperations)[number];
type TestApi = ReturnType<typeof fixtureApi>['api'];
type CaseContext = { api: TestApi; fixture: Fixture; operation: Operation };

function forgedHeaders(cookie: string, fixture: Fixture) {
  return {
    ...requestHeaders(cookie),
    'x-tenant-id': fixture.b.tenantId ?? '',
    'x-auth-user-id': fixture.b.userId,
    'x-profile-id': fixture.b.profileId,
    'x-role': 'admin',
  };
}
async function assertBSession(api: TestApi, cookie: string, fixture: Fixture) {
  const response = await api.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: requestHeaders(cookie),
  });
  expect(response.statusCode).toBe(200);
  expect(sessionResponseSchema.parse(response.json()).identity.profileId).toBe(
    fixture.b.profileId,
  );
}
async function insertIsolatedCdrs(fixture: Fixture) {
  await ensureCdrPartitions(connections.owner.db, { moment: new Date() });
  const answeredAt = new Date();
  const startedAt = new Date(answeredAt.getTime() - 60_000);
  const endedAt = new Date(answeredAt.getTime() + 60_000);
  for (const { tenantId, callee, country, unverified } of [
    {
      tenantId: fixture.a.tenantId,
      callee: '8613800138001',
      country: '中国',
      unverified: false,
    },
    {
      tenantId: fixture.a2.tenantId,
      callee: '8613800138002',
      country: '日本',
      unverified: false,
    },
    {
      tenantId: fixture.b.tenantId,
      callee: '447700900123',
      country: '英国',
      unverified: true,
    },
  ]) {
    expect(tenantId).not.toBeNull();
    const existing = await connections.owner.pool.query<{ exists: boolean }>(
      `select exists(select 1 from public.cdrs
       where tenant_id = $1 and callee = $2) as exists`,
      [tenantId, callee],
    );
    if (existing.rows[0]?.exists) continue;
    await connections.owner.pool.query(
      `insert into public.cdrs
        (tenant_id, call_uuid, started_at, answered_at, ended_at, caller, callee,
         billing_number, duration_seconds, billed_minutes, matched_prefix, country,
         rate, charge, hangup_cause, unverified, iso, description)
       values ($1,$2,$3,$4,$5,'1001',$6,$6,60,1,'86',$7,
         123456789012345678901234567890.1234,0.25,'NORMAL_CLEARING',$8,$9,$10)`,
      [
        tenantId,
        randomUUID(),
        startedAt,
        answeredAt,
        endedAt,
        callee,
        country,
        unverified,
        country === '中国' ? 'CN' : country === '日本' ? 'JP' : 'GB',
        `${country}说明`,
      ],
    );
  }
}
let statementFixtureCache: Promise<Fixture> | undefined;
/** 月账单用例共用的夹具：B 的第一个账单月份是 2026-06，A 的是 2026-08，A 没有 6 月。 */
function statementFixture(): Promise<Fixture> {
  statementFixtureCache ??= (async () => {
    const sf = await createFixture(connections);
    await ensureStatementPartitions(connections);
    const [a, b] = [sf.a.tenantId, sf.b.tenantId];
    if (!a || !b) throw new Error('Expected statement fixture tenants');
    await backdateTenant(connections, a, '2026-08-01 08:00:00');
    await backdateTenant(connections, b, '2026-06-05 08:00:00');
    await statementLedger(
      connections.owner,
      b,
      'recharge',
      '10',
      '2026-06-06 09:00:00',
      { adminId: sf.admin.profileId },
    );
    await generateMonth(connections, b, '2026-06-01');
    return sf;
  })();
  return statementFixtureCache;
}
const cases = {
  portalCdrs: async ({ api, fixture, operation }: CaseContext) => {
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const from = `${day.slice(0, 7)}-01`;
    const a = await login(api, fixture.a);
    const users = [
      { user: fixture.a, session: a, amount: '8613800138001', country: '中国' },
      {
        user: fixture.a2,
        session: await login(api, fixture.a2),
        amount: '8613800138002',
        country: '日本',
      },
      {
        user: fixture.b,
        session: await login(api, fixture.b),
        amount: '447700900123',
        country: '英国',
      },
    ] as const;
    await insertIsolatedCdrs(fixture);
    for (const { session, amount, country } of users) {
      const response = await api.inject({
        url: `${operation.path}?from=${from}&to=${day}&callee=${amount}`,
        headers: forgedHeaders(session.cookie, fixture),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = portalCdrsResponseSchema.parse(response.json());
      expect(body.pagination.total).toBe(1);
      expect(body.items[0]?.country).toBe(country);
      expect(body.items[0]?.iso).toBe(
        country === '中国' ? 'CN' : country === '日本' ? 'JP' : 'GB',
      );
      expect(body.items[0]?.description).toBe(`${country}说明`);
      expect(body.items[0]?.callee).toBe(amount);
      expect(JSON.stringify(body)).not.toContain('unverified');
    }
    for (const key of ['tenantId', 'tenant_id']) {
      const attack = await api.inject({
        url: `${operation.path}?from=${from}&to=${day}&${key}=${fixture.b.tenantId}`,
        headers: forgedHeaders(a.cookie, fixture),
      });
      expect(attack.statusCode).toBe(400);
    }
  },
  portalCdrCountries: async ({ api, fixture, operation }: CaseContext) => {
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const from = `${day.slice(0, 7)}-01`;
    const a = await login(api, fixture.a);
    const b = await login(api, fixture.b);
    await insertIsolatedCdrs(fixture);
    for (const { session, expectedCountry } of [
      { session: a, expectedCountry: '中国' },
      { session: b, expectedCountry: '英国' },
    ]) {
      const response = await api.inject({
        url: `${operation.path}?from=${from}&to=${day}`,
        headers: forgedHeaders(session.cookie, fixture),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(
        cdrCountriesResponseSchema.parse(response.json()).countries,
      ).toEqual([expectedCountry]);
    }
  },
  portalCdrsExport: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    await insertIsolatedCdrs(fixture);
    const tenantId = fixture.a.tenantId;
    if (!tenantId) throw new Error('Expected tenant A to exist');
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const beforeAudit = await connections.owner.pool.query<{ count: number }>(
      `select count(*)::int as count from public.operation_logs
       where action = 'cdr_export' and tenant_id = $1`,
      [tenantId],
    );
    const response = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
      payload: {
        from: `${day.slice(0, 7)}-01`,
        to: day,
        callee: '8613800138001',
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('8613800138001');
    expect(response.body).not.toContain('447700900123');
    expect(response.body).not.toContain('unverified');
    expect(response.body).toContain('123456789012345678901234567890.1234');
    const afterAudit = await connections.owner.pool.query<{ count: number }>(
      `select count(*)::int as count from public.operation_logs
       where action = 'cdr_export' and tenant_id = $1`,
      [tenantId],
    );
    expect(afterAudit.rows[0]?.count).toBe(beforeAudit.rows[0]?.count);
  },
  portalLedgerExport: async ({ api, operation }: CaseContext) => {
    const exportFixture = await createFixture(connections);
    const a = await login(api, exportFixture.a);
    const tenantId = exportFixture.a.tenantId;
    if (!tenantId) throw new Error('Expected export tenant A to exist');
    await withAdmin(connections.app.db, (tx) =>
      appendLedgerEntry(
        tx,
        { id: tenantId, currency: 'CNY' },
        {
          kind: 'credit_recharge',
          amount: money('CNY', '42.00'),
          note: 'private receivable note',
          adminId: exportFixture.admin.profileId,
          idempotencyKey: `idor-export-credit:${randomUUID()}`,
        },
      ),
    );
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const response = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, exportFixture),
      payload: { from: `${day.slice(0, 7)}-01`, to: day },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body).toContain('111.25');
    expect(response.body).toMatch(/,充值,42,/);
    expect(response.body).toContain('账户充值');
    expect(response.body).not.toContain('999.75');
    expect(response.body).not.toContain('private receivable note');
  },
  portalStatements: async ({ api, operation }: CaseContext) => {
    const sf = await statementFixture();
    for (const [user, currency, recharge, firstMonth] of [
      [sf.a, 'CNY', '111.25', '2026-08'],
      [sf.a2, 'CNY', '222.5', undefined],
      [sf.b, 'USD', '999.75', '2026-06'],
    ] as const) {
      const session = await login(api, user);
      const response = await api.inject({
        url: operation.path,
        headers: forgedHeaders(session.cookie, sf),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = portalStatementsResponseSchema.parse(response.json());
      expect(
        body.currency,
        'TENANT_FILTER_LEAK: portalStatements currency',
      ).toBe(currency);
      const now = body.items.find((item) => item.state === 'in_progress');
      expect(
        now?.figures.recharge,
        'TENANT_FILTER_LEAK: statements recharge',
      ).toBe(recharge);
      expect(body.items.at(-1)?.month).toBe(
        firstMonth ?? currentBeijingMonth(),
      );
      for (const other of ['111.25', '222.5', '999.75'])
        if (other !== recharge)
          expect(response.body, `TENANT_FILTER_LEAK: ${other}`).not.toContain(
            `"${other}"`,
          );
      expect(response.body).not.toMatch(
        /"(version|generatedBy|reconcile\w*|breakdownGap|tenantId)"/,
      );
    }
    const a = await login(api, sf.a);
    for (const key of ['tenantId', 'tenant_id']) {
      const attack = await api.inject({
        url: `${operation.path}?${key}=${sf.b.tenantId}`,
        headers: forgedHeaders(a.cookie, sf),
      });
      expect(attack.statusCode).toBe(400);
    }
  },
  portalStatement: async ({ api, operation }: CaseContext) => {
    const sf = await statementFixture();
    const url = (month: string) => operation.path.replace('{month}', month);
    const a = await login(api, sf.a);
    const b = await login(api, sf.b);
    const own = await api.inject({
      url: url(currentBeijingMonth()),
      headers: forgedHeaders(a.cookie, sf),
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(
      portalStatementResponseSchema.parse(own.json()).figures.closingBalance,
      'TENANT_FILTER_LEAK: portalStatement',
    ).toBe('111.25');
    // B 独有的月份：A 得到 404，与从不存在的月份无法区分；B 自己能读。
    const bOnly = await api.inject({
      url: url('2026-06'),
      headers: forgedHeaders(a.cookie, sf),
    });
    const never = await api.inject({
      url: url('2001-01'),
      headers: forgedHeaders(a.cookie, sf),
    });
    expect(bOnly.statusCode, bOnly.body).toBe(404);
    expect(never.statusCode).toBe(404);
    const strip = (body: string) =>
      Object.entries(apiErrorSchema.parse(JSON.parse(body)).error).filter(
        ([key]) => key !== 'requestId',
      );
    expect(strip(bOnly.body)).toEqual(strip(never.body));
    expect(bOnly.body).not.toContain(sf.b.tenantId ?? '');
    const mine = await api.inject({
      url: url('2026-06'),
      headers: forgedHeaders(b.cookie, sf),
    });
    expect(mine.statusCode, mine.body).toBe(200);
    const detail = portalStatementResponseSchema.parse(mine.json());
    expect(detail.currency).toBe('USD');
    expect(detail.figures.closingBalance).toBe('10');
    expect(mine.body).not.toMatch(
      /"(version|generatedBy|reconcile\w*|breakdownGap|tenantId)"/,
    );
    for (const key of ['tenantId', 'tenant_id']) {
      const attack = await api.inject({
        url: `${url('2026-06')}?${key}=${sf.b.tenantId}`,
        headers: forgedHeaders(a.cookie, sf),
      });
      expect(attack.statusCode).toBe(400);
    }
  },
  portalStatementExport: async ({ api, operation }: CaseContext) => {
    const sf = await statementFixture();
    const url = (month: string) => operation.path.replace('{month}', month);
    const a = await login(api, sf.a);
    const b = await login(api, sf.b);
    const own = await api.inject({
      method: 'POST',
      url: url(currentBeijingMonth()),
      headers: forgedHeaders(a.cookie, sf),
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers['content-type']).toContain('text/csv');
    const code = (
      await connections.owner.pool.query<{ code: string }>(
        'select code from public.tenants where id = $1',
        [sf.a.tenantId],
      )
    ).rows[0]?.code;
    expect(own.headers['content-disposition']).toContain(`statement_${code}_`);
    expect(own.body).toContain(',111.25');
    expect(own.body).not.toContain('999.75');
    expect(own.body).not.toContain('222.5');
    const bOnly = await api.inject({
      method: 'POST',
      url: url('2026-06'),
      headers: forgedHeaders(a.cookie, sf),
    });
    expect(bOnly.statusCode).toBe(404);
    expect(bOnly.headers['content-type']).toContain('application/json');
    expect(bOnly.body).not.toContain(',10');
    const mine = await api.inject({
      method: 'POST',
      url: url('2026-06'),
      headers: forgedHeaders(b.cookie, sf),
    });
    expect(mine.statusCode, mine.body).toBe(200);
    expect(mine.body).toContain('金额（USD）');
    expect(mine.body).not.toContain('111.25');
  },
  portalLedger: async ({ api, fixture, operation }: CaseContext) => {
    const day = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const range = `from=${day.slice(0, 7)}-01&to=${day}`;
    const a = await login(api, fixture.a);
    for (const [user, balance, currency] of [
      [fixture.a, '111.25', 'CNY'],
      [fixture.a2, '222.5', 'CNY'],
      [fixture.b, '999.75', 'USD'],
    ] as const) {
      const session = user === fixture.a ? a : await login(api, user);
      const response = await api.inject({
        method: 'GET',
        url: `${operation.path}?${range}`,
        headers: forgedHeaders(session.cookie, fixture),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = portalLedgerResponseSchema.parse(response.json());
      expect(body.currency, 'TENANT_FILTER_LEAK: portalLedger currency').toBe(
        currency,
      );
      expect(body.balance, 'TENANT_FILTER_LEAK: portalLedger balance').toBe(
        balance,
      );
      expect(body.totalAmount, 'TENANT_FILTER_LEAK: portalLedger amount').toBe(
        balance,
      );
      expect(body.items).toHaveLength(1);
      expect(body.items[0]?.amount).toBe(balance);
      expect(body.pagination.total).toBe(1);
    }
    for (const key of ['tenantId', 'tenant_id']) {
      const response = await api.inject({
        url: `${operation.path}?${range}&${key}=${fixture.b.tenantId}`,
        headers: forgedHeaders(a.cookie, fixture),
      });
      expect(response.statusCode).toBe(400);
    }
  },
  portalHome: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    await insertIsolatedCdrs(fixture);
    for (const { user, balance, currency, callee } of [
      {
        user: fixture.a,
        balance: '111.25',
        currency: 'CNY',
        callee: '8613800138001',
      },
      {
        user: fixture.a2,
        balance: '222.5',
        currency: 'CNY',
        callee: '8613800138002',
      },
      {
        user: fixture.b,
        balance: '999.75',
        currency: 'USD',
        callee: '447700900123',
      },
    ] as const) {
      const session = user === fixture.a ? a : await login(api, user);
      const response = await api.inject({
        url: operation.path,
        headers: forgedHeaders(session.cookie, fixture),
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = portalHomeResponseSchema.parse(response.json());
      expect(body.currency, 'TENANT_FILTER_LEAK: portalHome currency').toBe(
        currency,
      );
      expect(body.balance, 'TENANT_FILTER_LEAK: portalHome balance').toBe(
        balance,
      );
      expect(
        body.recentCalls.map((call) => call.callee),
        'TENANT_FILTER_LEAK: portalHome recent calls',
      ).toEqual([callee]);
      expect(body.usage.answeredCalls).toBe(1);
      expect(response.body).not.toMatch(/unverified/i);
    }
    for (const key of ['tenantId', 'tenant_id']) {
      const response = await api.inject({
        url: `${operation.path}?${key}=${fixture.b.tenantId}`,
        headers: forgedHeaders(a.cookie, fixture),
      });
      expect(response.statusCode).toBe(400);
    }
  },
  portalContext: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    const b = await login(api, fixture.b);
    for (const { user, expectedBalance } of [
      {
        user: fixture.a,
        expectedBalance: { amount: '111.25', currency: 'CNY' },
      },
      {
        user: fixture.a2,
        expectedBalance: { amount: '222.5', currency: 'CNY' },
      },
      {
        user: fixture.b,
        expectedBalance: { amount: '999.75', currency: 'USD' },
      },
    ]) {
      const current =
        user === fixture.a
          ? a
          : user === fixture.b
            ? b
            : await login(api, user);
      const balanceQueries = vi.spyOn(pg.Client.prototype, 'query');
      const response = await (async () => {
        try {
          const response = await api.inject({
            method: 'GET',
            url: operation.path,
            headers: requestHeaders(current.cookie),
          });
          const reads = balanceQueries.mock.calls.flatMap(([query], index) => {
            const text = z
              .union([
                z.string(),
                z.object({ text: z.string() }).transform((query) => query.text),
              ])
              .parse(query);
            const result: unknown = balanceQueries.mock.results[index]?.value;
            return text.includes('"tenant_balances"') ? [result] : [];
          });
          expect(reads).toHaveLength(1);
          const result = z
            .object({ rows: z.array(z.tuple([z.string()])) })
            .parse(await reads[0]);
          expect(
            result.rows.length,
            'TENANT_FILTER_LEAK_ROWS: portalContext read multiple tenant balances',
          ).toBeLessThanOrEqual(1);
          expect(
            result.rows,
            'TENANT_FILTER_LEAK: portalContext read another tenant balance',
          ).toEqual([[expectedBalance.amount]]);
          return response;
        } finally {
          balanceQueries.mockRestore();
        }
      })();
      expect(response.statusCode).toBe(200);
      const body = portalContextResponseSchema.parse(response.json());
      expect(body.identity.profileId).toBe(user.profileId);
      expect(body.identity.tenant.id).toBe(user.tenantId);
      expect(
        body.balance.amount,
        'TENANT_FILTER_LEAK: portalContext returned another tenant balance',
      ).toBe(expectedBalance.amount);
      expect(body.balance.currency).toBe(expectedBalance.currency);
    }
    const forged = await api.inject({
      method: 'GET',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
    });
    expect(forged.statusCode).toBe(200);
    expect(
      portalContextResponseSchema.parse(forged.json()).identity.profileId,
    ).toBe(fixture.a.profileId);
    expect(
      portalContextResponseSchema.parse(forged.json()).identity.tenant.id,
    ).toBe(fixture.a.tenantId);
    expect(
      portalContextResponseSchema.parse(forged.json()).balance.amount,
    ).toBe('111.25');
    for (const key of ['tenantId', 'tenant_id']) {
      const attack = await api.inject({
        method: 'GET',
        url: `${operation.path}?${key}=${fixture.b.tenantId}`,
        headers: forgedHeaders(a.cookie, fixture),
      });
      expect(attack.statusCode).toBe(400);
      expect(apiErrorSchema.parse(attack.json()).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
    const bodyAttack = await api.inject({
      method: 'GET',
      url: operation.path,
      payload: { tenantId: fixture.b.tenantId },
      headers: forgedHeaders(a.cookie, fixture),
    });
    expect(bodyAttack.statusCode).toBe(200);
    const body = portalContextResponseSchema.parse(bodyAttack.json());
    expect(body.identity.profileId).toBe(fixture.a.profileId);
    expect(body.identity.tenant.id).toBe(fixture.a.tenantId);
    expect(body.balance).toEqual({ currency: 'CNY', amount: '111.25' });
  },
  session: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    const b = await login(api, fixture.b);
    for (const headers of [
      requestHeaders(a.cookie),
      forgedHeaders(a.cookie, fixture),
    ]) {
      const response = await api.inject({
        method: 'GET',
        url: operation.path,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(sessionResponseSchema.parse(response.json())).toEqual(a.body);
    }
    const attack = await api.inject({
      method: 'GET',
      url: `${operation.path}?userId=${fixture.b.userId}`,
      headers: requestHeaders(a.cookie),
    });
    expect(attack.statusCode).toBe(400);
    await assertBSession(api, b.cookie, fixture);
  },
  logout: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    const b = await login(api, fixture.b);
    const attack = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
      payload: { userId: fixture.b.userId, sessionToken: b.cookie },
    });
    expect(attack.statusCode).toBe(400);
    const response = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
    });
    expect(response.statusCode).toBe(204);
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: requestHeaders(a.cookie),
        })
      ).statusCode,
    ).toBe(401);
    await assertBSession(api, b.cookie, fixture);
  },
  revokeOtherSessions: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    const other = await login(api, fixture.a);
    const b = await login(api, fixture.b);
    const attack = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
      payload: { userId: fixture.b.userId },
    });
    expect(attack.statusCode).toBe(400);
    const response = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
    });
    expect(response.statusCode).toBe(204);
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: requestHeaders(other.cookie),
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: requestHeaders(a.cookie),
        })
      ).statusCode,
    ).toBe(200);
    await assertBSession(api, b.cookie, fixture);
  },
  changePassword: async ({ api, fixture, operation }: CaseContext) => {
    const a = await login(api, fixture.a);
    const b = await login(api, fixture.b);
    const newPassword = 'IDOR-changed-password-58';
    const attack = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
      payload: {
        currentPassword: password,
        newPassword,
        userId: fixture.b.userId,
      },
    });
    expect(attack.statusCode).toBe(400);
    const response = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: forgedHeaders(a.cookie, fixture),
      payload: { currentPassword: password, newPassword },
    });
    expect(response.statusCode).toBe(200);
    expect(
      sessionResponseSchema.parse(response.json()).identity.profileId,
    ).toBe(fixture.a.profileId);
    expect(
      (
        await api.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: requestHeaders(a.cookie),
        })
      ).statusCode,
    ).toBe(401);
    const oldLogin = await api.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: fixture.a.email, password },
    });
    expect(apiErrorSchema.parse(oldLogin.json()).error.code).toBe(
      'INVALID_CREDENTIALS',
    );
    const changed = await login(api, fixture.a, newPassword);
    await assertBSession(api, b.cookie, fixture);
    await login(api, fixture.b);
    const restored = await api.inject({
      method: 'POST',
      url: operation.path,
      headers: requestHeaders(changed.cookie),
      payload: { currentPassword: newPassword, newPassword: password },
    });
    expect(restored.statusCode).toBe(200);
  },
} satisfies Record<string, (context: CaseContext) => Promise<void>>;
const caseKinds = new Map([
  ['portalContext', 'tenant-read'],
  ['portalCdrs', 'tenant-read'],
  ['portalCdrCountries', 'tenant-read'],
  ['portalCdrsExport', 'tenant-read'],
  ['portalLedgerExport', 'tenant-read'],
  ['portalLedger', 'tenant-read'],
  ['portalHome', 'tenant-read'],
  ['portalStatements', 'tenant-read'],
  ['portalStatement', 'tenant-read'],
  ['portalStatementExport', 'tenant-read'],
  ['session', 'self-session'],
  ['logout', 'self-session-mutation'],
  ['revokeOtherSessions', 'self-session-mutation'],
  ['changePassword', 'self-credential'],
]);
const adminProbeBodies: Partial<Record<string, object>> = {
  adminRateEdit: {
    baseVersionId: '11111111-1111-4111-8111-111111111111',
    entry: {
      iso: '',
      description: '',
      prefix: '1',
      country: '美国',
      rate: '0.01',
    },
    schedule: { kind: 'immediate' },
  },
  adminRateCancelFutureVersion: {
    versionId: '11111111-1111-4111-8111-111111111111',
  },
  adminRateImportPreview: {
    baseVersionId: '11111111-1111-4111-8111-111111111111',
    file: {
      filename: 'rates.csv',
      contentBase64: Buffer.from(
        'ISO,国家,号码前缀,说明,费率\n,美国,1,,0.01',
      ).toString('base64'),
    },
    schedule: { kind: 'immediate' },
  },
  adminRateImportCommit: { previewId: '11111111-1111-4111-8111-111111111111' },
  adminRateCopyPreview: {
    sourceVersionId: '11111111-1111-4111-8111-111111111111',
    targetTenantId: '22222222-2222-4222-8222-222222222222',
    targetBaseVersionId: '11111111-1111-4111-8111-111111111111',
    schedule: { kind: 'immediate' },
  },
  adminRateCopyCommit: { previewId: '11111111-1111-4111-8111-111111111111' },
  adminRateExport: { versionId: '11111111-1111-4111-8111-111111111111' },
  adminConfirmPayment: {
    expectedLatestSettlementId: null,
    receivedOn: '2020-01-01',
  },
  adminReversePayment: {
    settlementId: '11111111-1111-4111-8111-111111111111',
    reason: 'probe',
  },
  adminVoidReceivable: {
    adjustmentLedgerEntryId: '11111111-1111-4111-8111-111111111111',
    reason: 'probe',
  },
  adminTenantStatementRegenerate: { expectedVersion: 1 },
  adminUnassignedAssignPreview: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    selection: { ids: ['22222222-2222-4222-8222-222222222222'] },
  },
  adminUnassignedAssign: {
    tenantId: '11111111-1111-4111-8111-111111111111',
    selection: { group: { tag: 'ABC01' } },
    idempotencyKey: 'idor-probe',
    expected: { assignable: 1, noRate: 0, chargeTotal: '0.1' },
  },
  adminUnassignedIgnore: {
    selection: { group: { tag: 'ABC01' } },
    reason: 'probe',
  },
  adminUnassignedUnignore: { selection: { group: { tag: 'ABC01' } } },
  adminTenantCdrDelete: {
    fromMonth: '2026-08',
    toMonth: '2026-08',
    tenantCode: 'ABC001',
    expectedCount: 1,
  },
  adminAlertSettingsUpdate: {
    recipients: ['probe@example.com'],
    digestMinutes: 5,
    expectedVersion: 1,
  },
  adminAccountCreate: { name: 'probe', email: 'probe@example.com' },
  adminPortalAccountCreate: { email: 'probe@example.com' },
};
const registry = new Map(Object.entries(cases));
function coverageDifference(ids: readonly string[]) {
  return {
    missing: ids.filter((id) => !registry.has(id)),
    extra: [...registry.keys()].filter((id) => !ids.includes(id)),
  };
}
const difference = coverageDifference(
  customerOperations.map((operation) => operation.operationId),
);
const results: {
  lane: string;
  operationId: string;
  isolationCase: string;
  status: 'passed' | 'failed';
}[] = [];
let fixture: Fixture;
beforeAll(async () => {
  fixture = await createFixture(connections);
});
it('registers the ten phase 8 operations as admin-only', () => {
  const phase8 = [
    'adminUnassignedSummary',
    'adminUnassignedGroups',
    'adminUnassignedList',
    'adminUnassignedAssignPreview',
    'adminUnassignedAssign',
    'adminUnassignedIgnore',
    'adminUnassignedUnignore',
    'adminTenantCdrDeletionMonths',
    'adminTenantCdrDelete',
    'adminAuditLogs',
  ];
  const registered = operations.filter((operation) =>
    phase8.includes(operation.operationId),
  );
  expect(registered.map((operation) => operation.operationId).sort()).toEqual(
    [...phase8].sort(),
  );
  for (const operation of registered) {
    expect(operation['x-access'], operation.operationId).toBe('admin');
    expect(operation['x-isolation-case'], operation.operationId).toBe(
      'admin-only',
    );
  }
});

it('registers the six phase 9 operations as admin-only', () => {
  const phase9 = [
    'adminOverview',
    'adminSystemAlertsSummary',
    'adminSystemAlerts',
    'adminSystemAlertDetail',
    'adminAlertSettings',
    'adminAlertSettingsUpdate',
  ];
  const registered = operations.filter((operation) =>
    phase9.includes(operation.operationId),
  );
  expect(registered.map((operation) => operation.operationId).sort()).toEqual(
    [...phase9].sort(),
  );
  for (const operation of registered) {
    expect(operation['x-access'], operation.operationId).toBe('admin');
    expect(operation['x-isolation-case'], operation.operationId).toBe(
      'admin-only',
    );
  }
  // 设置的写入用 PUT，其余只读。
  expect(
    Object.fromEntries(
      registered.map((operation) => [operation.operationId, operation.method]),
    ),
  ).toMatchObject({
    adminOverview: 'get',
    adminAlertSettings: 'get',
    adminAlertSettingsUpdate: 'put',
  });
});

it('covers exactly the nonempty live OpenAPI customer operation set and rejects an omitted case', () => {
  expect(customerOperations.length).toBeGreaterThan(0);
  expect(difference).toEqual({ missing: [], extra: [] });
  for (const operation of customerOperations)
    expect(operation['x-isolation-case']).toBe(
      caseKinds.get(operation.operationId),
    );
  expect(
    coverageDifference([
      ...customerOperations.map((operation) => operation.operationId),
      'newCustomerOperation',
    ]).missing,
  ).toEqual(['newCustomerOperation']);
});
for (const lane of lanes) {
  const { api } = fixtureApi(connections, { ownerLane: lane === 'owner' });
  describe(`[${lane}] live OpenAPI customer isolation`, () => {
    it('logs in one portal account for each of three distinct fixture tenants', async () => {
      const customers = [fixture.a, fixture.a2, fixture.b];
      const tenantIds = customers.map((user) => user.tenantId);
      expect(new Set(tenantIds).size).toBe(3);
      const accounts = await connections.owner.pool.query<{
        tenant_id: string;
        count: number;
      }>(
        `SELECT tenant_id, count(*)::integer AS count FROM public.portal_accounts WHERE tenant_id = ANY($1::uuid[]) GROUP BY tenant_id ORDER BY tenant_id`,
        [tenantIds],
      );
      expect(accounts.rows).toEqual(
        [...tenantIds]
          .sort()
          .map((tenantId) => ({ tenant_id: tenantId, count: 1 })),
      );
      for (const user of customers) {
        const current = await login(api, user);
        expect(current.body.identity).toMatchObject({
          kind: 'customer',
          profileId: user.profileId,
          tenant: { id: user.tenantId },
        });
      }
    });

    it('rejects unauthenticated protected operations and customer access to all live admin operations', async () => {
      const current = await login(api, fixture.a);
      const before = await connections.owner.pool.query<{ password: string }>(
        'SELECT password FROM auth.account WHERE user_id=$1',
        [fixture.b.userId],
      );
      for (const operation of operations.filter(
        (operation) => operation['x-access'] !== 'public',
      )) {
        let url = operation.path
          .replace('{id}', fixture.b.profileId)
          .replace('{tenantId}', fixture.b.tenantId ?? '')
          .replace('{month}', '2026-09')
          .replace('{alertId}', fixture.b.profileId);
        if (
          [
            'portalLedger',
            'portalCdrs',
            'portalCdrCountries',
            'adminTenantLedger',
            'adminTenantCdrs',
            'adminTenantCdrCountries',
          ].includes(operation.operationId)
        )
          url += '?from=2026-09-01&to=2026-09-30';
        if (operation.operationId === 'adminTenantCdrDeletionMonths')
          url += '?year=2026';
        const method = z
          .enum(['GET', 'POST', 'PUT'])
          .parse(operation.method.toUpperCase());
        const payload =
          operation.operationId === 'changePassword'
            ? {
                currentPassword: password,
                newPassword: 'Unauthenticated-password-58',
              }
            : operation.operationId === 'adminTenantCreate'
              ? {
                  code: 'IDORPROBE',
                  name: 'probe',
                  currency: 'CNY',
                  settings: { lowBalanceThreshold: '10' },
                  initialRates: { kind: 'blank' },
                }
              : operation.operationId === 'adminTenantEdit'
                ? {
                    name: 'probe',
                    contactName: '',
                    contactPhone: '',
                    remark: '',
                  }
                : operation.operationId === 'adminTenantSettings'
                  ? {
                      overdraftLimit: '100',
                      lowBalanceThreshold: '10',
                      emails: [],
                    }
                  : operation.operationId === 'adminBalanceOperation'
                    ? {
                        kind: 'topup',
                        currency: 'CNY',
                        amount: '1',
                        idempotencyKey: 'idor-probe',
                      }
                    : operation.operationId === 'portalCdrsExport' ||
                        operation.operationId === 'portalLedgerExport' ||
                        operation.operationId === 'adminTenantCdrsExport'
                      ? { from: '2026-09-01', to: '2026-09-30' }
                      : adminProbeBodies[operation.operationId];
        const missing = await api.inject({
          method,
          url,
          ...(payload ? { payload } : {}),
        });
        expect(missing.statusCode, operation.operationId).toBe(401);
        expect(apiErrorSchema.parse(missing.json()).error.code).toBe(
          'UNAUTHENTICATED',
        );
        if (operation['x-access'] === 'admin') {
          const attack = await api.inject({
            method,
            url,
            headers: forgedHeaders(current.cookie, fixture),
            ...(payload ? { payload } : {}),
          });
          expect(attack.statusCode, operation.operationId).toBe(403);
          expect(apiErrorSchema.parse(attack.json()).error.code).toBe(
            'FORBIDDEN',
          );
        }
      }
      const after = await connections.owner.pool.query<{ password: string }>(
        'SELECT password FROM auth.account WHERE user_id=$1',
        [fixture.b.userId],
      );
      expect(before.rows.length).toBe(1);
      expect(after.rows.length).toBe(1);
      expect(after.rows[0]?.password === before.rows[0]?.password).toBe(true);
    });

    for (const operation of customerOperations) {
      it(`${operation.operationId} positive behavior and A to B attack`, async () => {
        const scenario = registry.get(operation.operationId);
        expect(
          scenario,
          `Missing executable IDOR case for ${operation.operationId}`,
        ).toBeDefined();
        if (!scenario)
          throw new Error(
            `Missing executable IDOR case for ${operation.operationId}`,
          );
        const result = {
          lane,
          operationId: operation.operationId,
          isolationCase: operation['x-isolation-case'],
          status: 'failed',
        } satisfies (typeof results)[number];
        results.push(result);
        await scenario({ api, fixture, operation });
        Object.assign(result, { status: 'passed' });
      });
    }
    it('a customer gets nothing from the phase 9 operations, even for a real alert', async () => {
      const probe = `idor-alert-${randomUUID()}`;
      const alert = await connections.owner.pool.query<{ id: string }>(
        `insert into public.system_alerts (kind, subject_key, tenant_id, description)
         values ('statement_mismatch', $1, $2, $3) returning id`,
        [probe, fixture.a.tenantId, `告警说明 ${probe}`],
      );
      const alertId = alert.rows[0]!.id;
      const settingsBefore = await connections.owner.pool.query<{
        version: number;
        recipients: string[];
      }>('select version, recipients from public.alert_settings');
      try {
        for (const user of [fixture.a, fixture.b]) {
          const session = await login(api, user);
          const requests: [string, string, object?][] = [
            ['GET', '/api/admin/overview'],
            ['GET', '/api/admin/system-alerts'],
            ['GET', '/api/admin/system-alerts?window=all&status=open'],
            ['GET', '/api/admin/system-alerts/summary'],
            ['GET', `/api/admin/system-alerts/${alertId}`],
            ['GET', '/api/admin/alert-settings'],
            [
              'PUT',
              '/api/admin/alert-settings',
              {
                recipients: ['customer-write@example.com'],
                digestMinutes: 1,
                expectedVersion: settingsBefore.rows[0]!.version,
              },
            ],
          ];
          for (const [method, url, payload] of requests) {
            const response = await api.inject({
              method: z.enum(['GET', 'PUT']).parse(method),
              url,
              headers: forgedHeaders(session.cookie, fixture),
              ...(payload ? { payload } : {}),
            });
            expect({ url, status: response.statusCode }).toEqual({
              url,
              status: 403,
            });
            expect(apiErrorSchema.parse(response.json()).error.code).toBe(
              'FORBIDDEN',
            );
            expect(response.body).not.toContain(probe);
          }
        }
        // 客户的写请求没有改动设置，也没有写操作日志。
        expect(
          (
            await connections.owner.pool.query<{
              version: number;
              recipients: string[];
            }>('select version, recipients from public.alert_settings')
          ).rows,
        ).toEqual(settingsBefore.rows);
        // 未登录同样得到 401，不带出数据。
        for (const url of [
          '/api/admin/overview',
          '/api/admin/system-alerts',
          `/api/admin/system-alerts/${alertId}`,
          '/api/admin/alert-settings',
        ]) {
          const response = await api.inject({ url });
          expect(response.statusCode, url).toBe(401);
          expect(response.body).not.toContain(probe);
        }
      } finally {
        await connections.owner.pool.query(
          'delete from public.system_alerts where id = $1',
          [alertId],
        );
      }
    });

    it('portal responses carry no notification, recipient or alert fields', async () => {
      const probeAddress = `idor-recipient-${randomUUID()}@example.test`;
      const probeAlert = `idor-alert-${randomUUID()}`;
      const tenantId = fixture.a.tenantId!;
      // 本租户有发件箱、送达记录、告警（含收件人地址）：门户的任何响应都不应带出。
      await connections.owner.pool.query(
        `insert into public.email_outbox (dedupe_key, template, params, recipients, tenant_id, status, skip_reason)
         values ($1, 'balance_low', '{}'::jsonb, array[$2]::text[], $3, 'skipped', 'idor_probe')`,
        [`idor-probe:${randomUUID()}`, probeAddress, tenantId],
      );
      await connections.owner.pool.query(
        `insert into public.balance_alert_deliveries (tenant_id, kind, balance, recipients)
         values ($1, 'low_balance', 1, array[$2]::text[])`,
        [tenantId, probeAddress],
      );
      const alert = await connections.owner.pool.query<{ id: string }>(
        `insert into public.system_alerts (kind, subject_key, tenant_id, description, recovered_at)
         values ('statement_mismatch', $1, $2, $3, now()) returning id`,
        [probeAlert, tenantId, probeAlert],
      );
      const day = new Date(Date.now() + 8 * 3600_000)
        .toISOString()
        .slice(0, 10);
      const keys = (value: unknown): string[] =>
        Array.isArray(value)
          ? value.flatMap(keys)
          : value !== null && typeof value === 'object'
            ? Object.entries(value).flatMap(([key, child]) => [
                key,
                ...keys(child),
              ])
            : [];
      try {
        const session = await login(api, fixture.a);
        for (const url of [
          '/api/portal/home',
          '/api/portal/context',
          `/api/portal/ledger?from=${day.slice(0, 7)}-01&to=${day}`,
          '/api/portal/statements',
        ]) {
          const response = await api.inject({
            url,
            headers: forgedHeaders(session.cookie, fixture),
          });
          expect({ url, status: response.statusCode }).toEqual({
            url,
            status: 200,
          });
          const body: unknown = response.json();
          expect(response.body).not.toContain(probeAddress);
          expect(response.body).not.toContain(probeAlert);
          expect(
            keys(body).filter((key) =>
              /notice|outbox|recipient|alert|digest|notify|dedupe|smtp|skip/i.test(
                key,
              ),
            ),
            url,
          ).toEqual([]);
        }
      } finally {
        await connections.owner.pool.query(
          'delete from public.system_alerts where id = $1',
          [alert.rows[0]!.id],
        );
      }
    });
    it('unfiltered SQL proves the owner bypass and the app RLS boundary', async () => {
      const db = lane === 'owner' ? connections.owner.db : connections.app.db;
      const rows = await withTenant(db, fixture.a.tenantId ?? '', (tx) =>
        tx
          .select({
            tenantId: schema.tenantBalances.tenantId,
            amount: schema.tenantBalances.balance,
          })
          .from(schema.tenantBalances),
      );
      if (lane === 'owner') {
        expect(rows).toEqual(
          expect.arrayContaining([
            { tenantId: fixture.a.tenantId, amount: '111.25' },
            { tenantId: fixture.a2.tenantId, amount: '222.5' },
            { tenantId: fixture.b.tenantId, amount: '999.75' },
          ]),
        );
      } else
        expect(rows).toEqual([
          { tenantId: fixture.a.tenantId, amount: '111.25' },
        ]);
    });
  });
}
afterAll(async () => {
  const directory = process.env.P4_IDOR_ARTIFACT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'openapi.json'),
    `${JSON.stringify(document, null, 2)}\n`,
  );
  await writeFile(
    resolve(directory, 'customer-operation-coverage.json'),
    `${JSON.stringify({ source: 'live Fastify OpenAPI', denominator: customerOperations.length, operations: customerOperations.map((operation) => ({ operationId: operation.operationId, access: operation['x-access'], isolationCase: operation['x-isolation-case'] })), difference, coverage: lanes.map((lane) => ({ lane, numerator: results.filter((result) => result.lane === lane && result.status === 'passed').length, denominator: customerOperations.length })), results }, null, 2)}\n`,
  );
});
