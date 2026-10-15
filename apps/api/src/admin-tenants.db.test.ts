import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  apiErrorSchemas,
  adminTenantCreateResponseSchema,
  adminTenantDetailResponseSchema,
  adminTenantOverviewResponseSchema,
  adminBalanceOperationResponseSchema,
  adminLedgerResponseSchema,
  adminTenantsResponseSchema,
  createAdminAmountRequestSchemas,
} from '@fs-billing/shared';
import {
  operateBalance,
  updateTenantSettings,
  withAdmin,
} from '@fs-billing/db';
import { createApi } from './app.js';
import { apiEnvironmentSchema } from './config.js';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  requestHeaders,
  type Fixture,
} from '../test/support.js';

const connections = apiConnections();
const { api, auth } = fixtureApi(connections);
let fixture: Fixture;
let cookie: string;
beforeAll(async () => {
  fixture = await createFixture(connections);
  cookie = (await login(api, fixture.admin)).cookie;
});
const tenantBody = (currency: 'CNY' | 'USD' = 'CNY') => ({
  code: `api${randomUUID().replaceAll('-', '')}`,
  name: 'API租户',
  currency,
  settings: { lowBalanceThreshold: '10' },
  initialRates: { kind: 'blank' },
});
async function create(currency: 'CNY' | 'USD' = 'CNY') {
  const response = await api.inject({
    method: 'POST',
    url: '/api/admin/tenants',
    headers: requestHeaders(cookie),
    payload: tenantBody(currency),
  });
  expect(response.statusCode, response.body).toBe(200);
  return adminTenantCreateResponseSchema.parse(response.json());
}

describe('admin tenant and balance API', () => {
  it('serves the admin overview and rejects unknown, malformed and unauthenticated tenant reads', async () => {
    const { tenant } = await create('USD');
    const response = await api.inject({
      method: 'GET',
      url: `/api/admin/tenants/${tenant.id}/overview`,
      headers: requestHeaders(cookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const value = adminTenantOverviewResponseSchema.parse(response.json());
    expect(value).toMatchObject({
      currency: 'USD',
      monthSpend: '0',
      monthCallMinutes: '0',
      answeredCalls: 0,
      unansweredCalls: 0,
      dailyTotal: '0',
    });
    expect(value.daily).toHaveLength(30);
    expect(value.daily.every((day) => day.spend === '0')).toBe(true);
    expect(response.headers['cache-control']).toContain('no-store');
    for (const [id, status] of [
      [randomUUID(), 404],
      ['invalid', 400],
    ] as const) {
      const rejected = await api.inject({
        method: 'GET',
        url: `/api/admin/tenants/${id}/overview`,
        headers: requestHeaders(cookie),
      });
      expect(rejected.statusCode, rejected.body).toBe(status);
      if (status === 404) {
        expect(rejected.json()).toMatchObject({
          error: { code: 'NOT_FOUND', message: '租户不存在' },
        });
        expect(rejected.headers['cache-control']).toContain('no-store');
      }
    }
    const anonymous = await api.inject(
      `/api/admin/tenants/${tenant.id}/overview`,
    );
    expect(anonymous.statusCode, anonymous.body).toBe(401);
  });

  it('prevents customer IDOR against both tenant overviews despite forged admin and tenant headers', async () => {
    const customer = (await login(api, fixture.a)).cookie;
    for (const tenantId of [fixture.a.tenantId, fixture.b.tenantId]) {
      const response = await api.inject({
        method: 'GET',
        url: `/api/admin/tenants/${tenantId}/overview`,
        headers: {
          ...requestHeaders(customer),
          'x-role': 'admin',
          'x-tenant-id': tenantId ?? '',
        },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
  });

  it.each(['40001', '40P01'])(
    'returns 503 after outermost %s retries are exhausted',
    async (code) => {
      const custom = createApi({ businessDb: connections.app.db, auth });
      let attempts = 0;
      custom.get('/test-exhausted-retries', () =>
        withAdmin(connections.app.db, async (tx) => {
          attempts += 1;
          await tx.execute(
            sql.raw(
              `do $$ begin raise exception 'private database failure' using errcode = '${code}'; end $$`,
            ),
          );
        }),
      );
      try {
        const response = await custom.inject('/test-exhausted-retries');
        expect(attempts).toBe(3);
        expect(response.statusCode, response.body).toBe(503);
        expect(
          apiErrorSchemas.SERVICE_UNAVAILABLE.parse(response.json()),
        ).toMatchObject({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: '服务暂不可用',
          },
        });
      } finally {
        await custom.close();
      }
    },
  );

  it.each([3, 11])(
    'uses the configured %i digit cap in routes and services',
    async (digits) => {
      const cap =
        apiEnvironmentSchema.shape.ADMIN_AMOUNT_MAX_INTEGER_DIGITS.parse(
          String(digits),
        );
      const amountRequests = createAdminAmountRequestSchemas(cap);
      const custom = createApi({
        businessDb: connections.app.db,
        auth,
        trustedOrigins: ['http://localhost:3000'],
        adminAmountMaxIntegerDigits: cap,
      });
      const headers = requestHeaders(cookie);
      const allowed = '9'.repeat(digits);
      const excessive = '1' + '0'.repeat(digits);
      const actor = { id: fixture.admin.profileId, name: 'admin' };
      try {
        const rejectedCreate = await custom.inject({
          method: 'POST',
          url: '/api/admin/tenants',
          headers,
          payload: {
            ...tenantBody(),
            settings: { lowBalanceThreshold: excessive },
          },
        });
        expect(rejectedCreate.statusCode, rejectedCreate.body).toBe(400);
        const created = await custom.inject({
          method: 'POST',
          url: '/api/admin/tenants',
          headers,
          payload: {
            ...tenantBody(),
            settings: { lowBalanceThreshold: allowed },
          },
        });
        expect(created.statusCode, created.body).toBe(200);
        const { tenant } = adminTenantCreateResponseSchema.parse(
          created.json(),
        );
        const path = `/api/admin/tenants/${tenant.id}`;
        for (const amount of [excessive, allowed]) {
          const settings = {
            overdraftLimit: amount,
            lowBalanceThreshold: amount,
            emails: [],
          };
          const balance = {
            kind: 'topup' as const,
            currency: 'CNY' as const,
            amount,
            idempotencyKey: randomUUID(),
          };
          for (const [suffix, payload] of [
            ['/settings', settings],
            ['/balance-operations', balance],
          ] as const) {
            const response = await custom.inject({
              method: 'POST',
              url: path + suffix,
              headers,
              payload,
            });
            expect(response.statusCode, response.body).toBe(
              amount === allowed ? 200 : 400,
            );
          }
          if (amount === excessive) {
            await expect(async () =>
              updateTenantSettings({
                db: connections.app.db,
                actor,
                tenantId: tenant.id,
                amountRequests,
                request: settings,
              }),
            ).rejects.toThrow();
            await expect(
              operateBalance({
                db: connections.app.db,
                actor,
                tenantId: tenant.id,
                amountRequests,
                request: { ...balance, note: '' },
              }),
            ).rejects.toThrow();
            expect(
              (
                await connections.owner.pool.query(
                  'SELECT id FROM ledger_entries WHERE tenant_id=$1',
                  [tenant.id],
                )
              ).rows,
            ).toEqual([]);
          }
        }
        const saved = await custom.inject({ url: path, headers });
        expect(
          adminTenantDetailResponseSchema.parse(saved.json()),
        ).toMatchObject({
          balance: allowed,
          settings: { overdraftLimit: allowed, lowBalanceThreshold: allowed },
        });
        expect(
          (
            await connections.owner.pool.query(
              'SELECT amount = $2::numeric AS matches FROM ledger_entries WHERE tenant_id=$1',
              [tenant.id, allowed],
            )
          ).rows,
        ).toEqual([{ matches: true }]);
      } finally {
        await custom.close();
      }
    },
  );

  it('keeps unconfigured tenants in the list and rejects only detail', async () => {
    const tenantId = fixture.a.tenantId;
    const headers = requestHeaders(cookie);
    const detail = await api.inject({
      url: `/api/admin/tenants/${tenantId}`,
      headers,
    });
    expect(detail.statusCode, detail.body).toBe(500);
    const failure = apiErrorSchemas.INTERNAL_ERROR.parse(detail.json());
    expect(detail.json()).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务内部错误',
        requestId: failure.error.requestId,
      },
    });
    const list = await api.inject({
      url: `/api/admin/tenants?search=A${fixture.prefix.replaceAll('-', '')}`,
      headers,
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = adminTenantsResponseSchema.parse(list.json());
    expect(listed.items.find((item) => item.id === tenantId)).toMatchObject({
      id: tenantId,
      settingsConfigured: false,
      health: 'normal',
    });
    expect(
      (
        await connections.owner.pool.query(
          'select tenant_id from balance_alert_settings where tenant_id=$1',
          [tenantId],
        )
      ).rows,
    ).toEqual([]);
  });

  it('creates, reads, edits, disables, enables and updates settings using the admin session', async () => {
    const created = await create();
    expect(created.tenant.settings.emails).toEqual([fixture.admin.email]);
    const path = `/api/admin/tenants/${created.tenant.id}`;
    const get = await api.inject({
      url: path,
      headers: requestHeaders(cookie),
    });
    expect(get.statusCode).toBe(200);
    expect(get.headers['cache-control']).toBe('no-store');
    expect(adminTenantDetailResponseSchema.parse(get.json())).toEqual(
      created.tenant,
    );
    for (const [suffix, payload] of [
      [
        '/edit',
        {
          name: '编辑租户',
          contactName: '联系人',
          contactPhone: '123',
          remark: '备注',
        },
      ],
      ['/disable', undefined],
      ['/enable', undefined],
      [
        '/settings',
        {
          overdraftLimit: '25',
          lowBalanceThreshold: '5',
          emails: ['Notify@example.com', 'notify@example.com'],
        },
      ],
    ] as const) {
      const response = await api.inject({
        method: 'POST',
        url: path + suffix,
        headers: requestHeaders(cookie),
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toHaveProperty('auditId');
    }
    const saved = await api.inject({
      url: path,
      headers: requestHeaders(cookie),
    });
    expect(adminTenantDetailResponseSchema.parse(saved.json())).toMatchObject({
      name: '编辑租户',
      status: 'active',
      settings: {
        overdraftLimit: '25',
        lowBalanceThreshold: '5',
        emails: ['notify@example.com'],
      },
    });
  });

  it('maps code collisions, ownership failures and currency mismatches to declared errors', async () => {
    const body = tenantBody();
    const headers = requestHeaders(cookie);
    const first = await api.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      headers,
      payload: body,
    });
    const source = adminTenantCreateResponseSchema.parse(first.json());
    const collision = await api.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      headers,
      payload: { ...body, code: body.code.toUpperCase() },
    });
    expect(collision.statusCode).toBe(409);
    expect(collision.json()).toMatchObject({
      error: { code: 'TENANT_CODE_EXISTS' },
    });
    const mismatch = await api.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      headers,
      payload: {
        ...tenantBody('USD'),
        initialRates: {
          kind: 'copy',
          sourceTenantId: source.tenant.id,
          sourceVersionId: source.initialRateVersionId,
        },
      },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({
      error: { code: 'CURRENCY_MISMATCH' },
    });
    const foreign = await api.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      headers,
      payload: {
        ...tenantBody(),
        initialRates: {
          kind: 'copy',
          sourceTenantId: randomUUID(),
          sourceVersionId: source.initialRateVersionId,
        },
      },
    });
    expect(foreign.statusCode).toBe(404);
  });

  it('performs all balance kinds with exact precision, credit projection, idempotency and stable ledger pagination', async () => {
    const { tenant } = await create();
    const path = `/api/admin/tenants/${tenant.id}`;
    const headers = requestHeaders(cookie);
    const credit = {
      kind: 'credit_topup',
      currency: 'CNY',
      amount: '100.50',
      internalNote: '内部赊账',
      idempotencyKey: randomUUID(),
    };
    const response = await api.inject({
      method: 'POST',
      url: path + '/balance-operations',
      headers,
      payload: credit,
    });
    expect(response.statusCode, response.body).toBe(200);
    const original = adminBalanceOperationResponseSchema.parse(response.json());
    expect(original.entry).toMatchObject({
      kind: 'credit_recharge',
      note: '内部赊账',
      noteVisibility: 'admin',
      paymentStatus: 'pending',
      actor: { id: fixture.admin.profileId, name: 'admin' },
    });
    const replay = await api.inject({
      method: 'POST',
      url: path + '/balance-operations',
      headers,
      payload: credit,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(response.json());
    const conflict = await api.inject({
      method: 'POST',
      url: path + '/balance-operations',
      headers,
      payload: { ...credit, internalNote: 'changed' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    for (const payload of [
      {
        kind: 'topup',
        currency: 'CNY',
        amount: '2',
        note: '充值',
        idempotencyKey: randomUUID(),
      },
      {
        kind: 'gift',
        currency: 'CNY',
        amount: '3',
        note: '赠送',
        idempotencyKey: randomUUID(),
      },
      {
        kind: 'adjustment',
        currency: 'CNY',
        amount: '-0.0001',
        reason: '精确调账',
        idempotencyKey: randomUUID(),
      },
    ]) {
      const mutation = await api.inject({
        method: 'POST',
        url: path + '/balance-operations',
        headers,
        payload,
      });
      expect(mutation.statusCode, mutation.body).toBe(200);
    }
    const detail = await api.inject({ url: path, headers });
    expect(adminTenantDetailResponseSchema.parse(detail.json())).toMatchObject({
      balance: '105.4999',
      pendingReceivable: '100.5',
    });
    const ledger = await api.inject({
      url: path + '/ledger?pageSize=2',
      headers,
    });
    expect(ledger.statusCode, ledger.body).toBe(200);
    expect(adminLedgerResponseSchema.parse(ledger.json())).toMatchObject({
      currency: 'CNY',
      pagination: { page: 1, pageSize: 2, total: 4 },
    });
  });

  it('rejects adjustment without a reason and invalid precision or caps before writes', async () => {
    const { tenant } = await create();
    const headers = requestHeaders(cookie);
    const url = `/api/admin/tenants/${tenant.id}/balance-operations`;
    for (const payload of [
      {
        kind: 'adjustment',
        currency: 'CNY',
        amount: '-1',
        idempotencyKey: randomUUID(),
      },
      {
        kind: 'adjustment',
        currency: 'CNY',
        amount: '-1.00001',
        reason: '超精度',
        idempotencyKey: randomUUID(),
      },
      {
        kind: 'topup',
        currency: 'CNY',
        amount: '1.001',
        idempotencyKey: randomUUID(),
      },
      {
        kind: 'gift',
        currency: 'CNY',
        amount: '10000000000',
        idempotencyKey: randomUUID(),
      },
    ]) {
      const response = await api.inject({
        method: 'POST',
        url,
        headers,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'VALIDATION_ERROR' },
      });
    }
    expect(
      (
        await connections.owner.pool.query(
          'select id from ledger_entries where tenant_id=$1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([]);
  });

  it('lists per-currency balances without a combined total and preserves group ordering', async () => {
    const prefix = `CURRENCIES${randomUUID().replaceAll('-', '')}`;
    for (const [suffix, currency, amount] of [
      ['A', 'USD', '1'],
      ['B', 'CNY', '100'],
      ['C', 'CNY', '2'],
    ] as const) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/admin/tenants',
        headers: requestHeaders(cookie),
        payload: {
          ...tenantBody(currency),
          code: prefix + suffix,
          settings: { lowBalanceThreshold: '0' },
        },
      });
      const { tenant } = adminTenantCreateResponseSchema.parse(response.json());
      expect(
        (
          await api.inject({
            method: 'POST',
            url: `/api/admin/tenants/${tenant.id}/balance-operations`,
            headers: requestHeaders(cookie),
            payload: {
              kind: 'topup',
              currency,
              amount,
              idempotencyKey: randomUUID(),
            },
          })
        ).statusCode,
      ).toBe(200);
    }
    const response = await api.inject({
      url: `/api/admin/tenants?search=${prefix}`,
      headers: requestHeaders(cookie),
    });
    expect(response.statusCode, response.body).toBe(200);
    const result = adminTenantsResponseSchema.parse(response.json());
    expect(result.items.map((item) => [item.currency, item.balance])).toEqual([
      ['CNY', '2'],
      ['CNY', '100'],
      ['USD', '1'],
    ]);
    expect(response.json()).not.toHaveProperty('totalBalance');
  });

  it('independently decodes CSV, maps row and encoding errors, and accepts valid uploads above one MiB', async () => {
    const headers = requestHeaders(cookie);
    for (const [bytes, code] of [
      [Buffer.from('1,美国,-1'), 'CSV_INVALID'],
      [Buffer.from([0xff]), 'CSV_ENCODING_UNSUPPORTED'],
    ] as const) {
      const response = await api.inject({
        method: 'POST',
        url: '/api/admin/tenants',
        headers,
        payload: {
          ...tenantBody(),
          initialRates: {
            kind: 'csv',
            file: {
              filename: 'rates.csv',
              contentBase64: bytes.toString('base64'),
            },
          },
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json()).toMatchObject({ error: { code } });
      if (code === 'CSV_INVALID')
        expect(response.json()).toHaveProperty('error.rows.0.line', 1);
    }
    const content = Buffer.from(
      'prefix,country,rate\n' + '\n'.repeat(1024 * 1024) + '1,美国,0.01',
    );
    const response = await api.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      headers,
      payload: {
        ...tenantBody(),
        initialRates: {
          kind: 'csv',
          file: {
            filename: 'large.csv',
            contentBase64: content.toString('base64'),
          },
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('requires admin identity and rejects customer access to tenant data and balance mutations', async () => {
    const { tenant } = await create();
    const customer = (await login(api, fixture.a)).cookie;
    for (const [method, url, payload] of [
      ['GET', `/api/admin/tenants/${tenant.id}`, undefined],
      ['GET', `/api/admin/tenants/${tenant.id}/ledger`, undefined],
      [
        'POST',
        `/api/admin/tenants/${tenant.id}/balance-operations`,
        {
          kind: 'topup',
          currency: 'CNY',
          amount: '1',
          idempotencyKey: randomUUID(),
        },
      ],
      ['POST', '/api/admin/tenants', tenantBody()],
    ] as const) {
      const response = await api.inject({
        method,
        url,
        headers: {
          ...requestHeaders(customer),
          'x-role': 'admin',
          'x-tenant-id': tenant.id,
        },
        ...(payload ? { payload } : {}),
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(
      (
        await connections.owner.pool.query(
          'select id from ledger_entries where tenant_id=$1',
          [tenant.id],
        )
      ).rows,
    ).toEqual([]);
  });
});
