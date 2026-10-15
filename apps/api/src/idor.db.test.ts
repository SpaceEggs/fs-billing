import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { schema, withTenant } from '@fs-billing/db';
import {
  apiErrorSchema,
  portalContextResponseSchema,
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
const cases = {
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
  ['session', 'self-session'],
  ['logout', 'self-session-mutation'],
  ['revokeOtherSessions', 'self-session-mutation'],
  ['changePassword', 'self-credential'],
]);
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
        const url = operation.path.replace('{id}', fixture.b.profileId);
        const method = z
          .enum(['GET', 'POST'])
          .parse(operation.method.toUpperCase());
        const payload =
          operation.operationId === 'changePassword'
            ? {
                currentPassword: password,
                newPassword: 'Unauthenticated-password-58',
              }
            : undefined;
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
