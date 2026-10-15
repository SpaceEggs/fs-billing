import pg from 'pg';
import { parseAccountInput, parseAccountOutput } from 'better-auth/db';
import { afterAll, expect, test } from 'vitest';
import { connect, DatabaseUnavailableError } from '@fs-billing/db';
import { apiErrorSchema, apiErrorSchemas } from '@fs-billing/shared';
import { z } from 'zod';
import { liveApiContract } from './routes/contract.js';
import { assertEffectiveAuthOptions } from './auth/better-auth.js';
import { createApi } from './app.js';
import {
  assertAuthOptions,
  createAuthGateway,
  normalizeEmail,
} from './auth/gateway.js';
import { apiEnvironmentSchema } from './config.js';
import { generateOpenApi } from './openapi.js';

const business = connect('postgresql://fs_billing_app@127.0.0.1/fs_billing');
const pool = new pg.Pool();
const auth = createAuthGateway({
  pool,
  secret: 'unit-test-only-secret-with-32-characters',
  baseURL: 'http://localhost:3000',
  secureCookies: false,
  trustedOrigins: ['http://localhost:3000'],
  logger: { info() {}, error() {} },
});
const app = createApi({ businessDb: business.db, auth });
afterAll(async () => {
  await app.close();
  await Promise.all([business.pool.end(), pool.end()]);
});

test('API exposes an independent health endpoint', async () => {
  const response = await app.inject('/api/health');
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok', service: 'api' });
});

test.each([
  [
    'typed database transport failure',
    new DatabaseUnavailableError(
      new Error('Connection terminated unexpectedly'),
    ),
    503,
    'SERVICE_UNAVAILABLE',
  ],
  [
    'unclassified error',
    new Error('private implementation detail'),
    500,
    'INTERNAL_ERROR',
  ],
  ['service schema failure', new z.ZodError([]), 500, 'INTERNAL_ERROR'],
  [
    'constraint failure',
    Object.assign(new Error('private constraint'), { code: '23505' }),
    500,
    'INTERNAL_ERROR',
  ],
  ...[
    '40001',
    '40P01',
    '08006',
    '57P01',
    '57P02',
    '57P03',
    '53300',
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
  ].map(
    (code) =>
      [
        code,
        new Error('private query', {
          cause: Object.assign(new Error('private driver detail'), { code }),
        }),
        503,
        'SERVICE_UNAVAILABLE',
      ] as const,
  ),
] as const)(
  'global error handler classifies %s without exposing details',
  async (_label, error, status, code) => {
    const isolated = createApi({ businessDb: business.db, auth });
    isolated.get('/test-failure', () => {
      throw error;
    });
    try {
      const response = await isolated.inject('/test-failure');
      expect(response.statusCode).toBe(status);
      expect(apiErrorSchemas[code].parse(response.json())).toMatchObject({
        error: {
          code,
          message: status === 500 ? '服务内部错误' : '服务暂不可用',
        },
      });
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await isolated.close();
    }
  },
);

test('live OpenAPI contains every contract operation with its access and isolation metadata', async () => {
  const { operations } = await generateOpenApi(app);
  expect(operations.map((operation) => operation.operationId).sort()).toEqual(
    Object.keys(liveApiContract).sort(),
  );
});

test('protected routes without a cookie use the reauthentication contract and never query business data', async () => {
  for (const url of [
    '/api/auth/session',
    '/api/portal/context',
    '/api/admin/context',
  ]) {
    const response = await app.inject(url);
    expect(response.statusCode).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error).toMatchObject({
      code: 'UNAUTHENTICATED',
      action: 'reauthenticate',
    });
    expect(response.headers['cache-control']).toBe('no-store');
  }
});

test('strict request schemas reject tenant overrides and invalid credentials before authentication', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: 'a@example.com', password: 'secret', tenantId: 'forged' },
  });
  expect(response.statusCode).toBe(400);
  expect(apiErrorSchema.parse(response.json()).error.code).toBe(
    'VALIDATION_ERROR',
  );
  expect(response.body).not.toContain('secret');
  const query = await app.inject('/api/portal/context?tenant_id=forged');
  expect(query.statusCode).toBe(400);
});

test('credential routes share one IP limit before validation and ignore forwarded IP headers', async () => {
  const limited = createApi({
    businessDb: business.db,
    auth,
    rateLimit: { max: 3, timeWindow: 60_000 },
  });
  try {
    for (const url of [
      '/api/auth/login',
      '/api/auth/login',
      '/api/auth/change-password',
    ]) {
      const response = await limited.inject({
        method: 'POST',
        url,
        payload: {},
        remoteAddress: '127.9.0.1',
      });
      expect(response.statusCode).toBe(400);
    }
    for (const url of ['/api/auth/login', '/api/auth/change-password']) {
      const response = await limited.inject({
        method: 'POST',
        url,
        headers: { 'x-forwarded-for': '8.8.8.8' },
        payload: {},
        remoteAddress: '127.9.0.1',
      });
      expect(response.statusCode).toBe(429);
      const { error } = apiErrorSchema.parse(response.json());
      expect(error.code).toBe('RATE_LIMITED');
      if (error.code !== 'RATE_LIMITED') throw new Error('Expected rate limit');
      expect(error.retryAfterSeconds).toBeGreaterThan(0);
      expect(error.retryAfterSeconds).toBeLessThanOrEqual(60);
      expect(response.headers['retry-after']).toBe(
        String(error.retryAfterSeconds),
      );
    }
    const otherIp = await limited.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {},
      remoteAddress: '127.9.0.2',
    });
    expect(otherIp.statusCode).toBe(400);
    const logout = await limited.inject({
      method: 'POST',
      url: '/api/auth/logout',
      remoteAddress: '127.9.0.1',
    });
    expect(logout.statusCode).toBe(401);
    expect(apiErrorSchema.parse(logout.json()).error.code).toBe(
      'UNAUTHENTICATED',
    );
  } finally {
    await limited.close();
  }
});

test('bodyless writes reject unexpected fields and cross-site origins before session lookup', async () => {
  for (const url of ['/api/auth/logout', '/api/auth/revoke-other-sessions']) {
    const invalid = await app.inject({
      method: 'POST',
      url,
      payload: { tenant: 'forged' },
    });
    expect(invalid.statusCode).toBe(400);
    const untrusted = await app.inject({
      method: 'POST',
      url,
      headers: { origin: 'https://attacker.example' },
    });
    expect(untrusted.statusCode).toBe(403);
    expect(apiErrorSchema.parse(untrusted.json()).error.code).toBe('FORBIDDEN');
  }
});

test('Better Auth internal sign-up and reset HTTP routes are not exposed', async () => {
  for (const url of ['/api/auth/sign-up/email', '/api/auth/reset-password']) {
    expect(
      (await app.inject({ method: 'POST', url, payload: {} })).statusCode,
    ).toBe(404);
  }
});

test('temporary password issuance is optional server metadata and never client input or output', () => {
  const options = auth.auth.options;
  expect(parseAccountInput(options, {})).toEqual({});
  const account = {
    id: 'credential-account',
    accountId: 'auth-user',
    providerId: 'credential',
    userId: 'auth-user',
    createdAt: new Date('2026-10-14T00:00:00Z'),
    updatedAt: new Date('2026-10-14T00:00:00Z'),
    temporaryPasswordIssuedAt: new Date('2026-10-14T00:00:00Z'),
  };
  expect(() => parseAccountInput(options, account)).toThrow(
    'temporaryPasswordIssuedAt is not allowed to be set',
  );
  expect(parseAccountOutput(options, account)).toEqual({
    id: account.id,
    accountId: account.accountId,
    providerId: account.providerId,
    userId: account.userId,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  });
});

test('startup rejects session caching and secondary storage on effective Better Auth options', async () => {
  const context = await auth.auth.$context;
  await expect(assertEffectiveAuthOptions(auth.auth)).resolves.toBeUndefined();
  const cache = context.options.session?.cookieCache;
  if (!cache) throw new Error('Expected configured cookie cache options');
  const originalEnabled = cache.enabled;
  try {
    cache.enabled = true;
    await expect(assertEffectiveAuthOptions(auth.auth)).rejects.toThrow(
      'cookieCache.enabled=false',
    );
  } finally {
    cache.enabled = originalEnabled;
  }
  try {
    Reflect.set(context.options, 'secondaryStorage', {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    });
    await expect(assertEffectiveAuthOptions(auth.auth)).rejects.toThrow(
      'cookieCache.enabled=false',
    );
  } finally {
    Reflect.deleteProperty(context.options, 'secondaryStorage');
  }
  expect(() =>
    assertAuthOptions({ session: { cookieCache: { enabled: false } } }),
  ).not.toThrow();
  for (const options of [
    {},
    { session: { cookieCache: { enabled: true } } },
    { session: { cookieCache: { enabled: false } }, secondaryStorage: {} },
  ]) {
    expect(() => assertAuthOptions(options)).toThrow(
      'cookieCache.enabled=false',
    );
  }
});

test('email counter normalization matches Better Auth lowercase without trimming', () => {
  expect(normalizeEmail(' A@EXAMPLE.COM ')).toBe(' a@example.com ');
});

test('runtime environment enforces the auth and business roles and production HTTPS', () => {
  const env = {
    APP_DATABASE_URL: 'postgresql://fs_billing_app@localhost/db',
    AUTH_DATABASE_URL: 'postgresql://fs_billing_auth@localhost/db',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:3000',
  };
  expect(apiEnvironmentSchema.parse(env).API_PORT).toBe(3000);
  expect(
    apiEnvironmentSchema.safeParse({
      ...env,
      AUTH_DATABASE_URL: env.APP_DATABASE_URL,
    }).success,
  ).toBe(false);
  expect(
    apiEnvironmentSchema.safeParse({
      ...env,
      APP_DATABASE_URL: 'postgresql://owner@localhost/db',
    }).success,
  ).toBe(false);
  expect(
    apiEnvironmentSchema.safeParse({ ...env, NODE_ENV: 'production' }).success,
  ).toBe(false);
});

test('startup rejects an amount cap below the largest default tenant overdraft', () => {
  const env = {
    APP_DATABASE_URL: 'postgresql://fs_billing_app@localhost/db',
    AUTH_DATABASE_URL: 'postgresql://fs_billing_auth@localhost/db',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    BETTER_AUTH_URL: 'http://localhost:3000',
  };
  const invalid = apiEnvironmentSchema.safeParse({
    ...env,
    ADMIN_AMOUNT_MAX_INTEGER_DIGITS: '2',
  });
  expect(invalid.success).toBe(false);
  if (invalid.success) throw new Error('Expected startup config rejection');
  expect(invalid.error.issues).toEqual([
    expect.objectContaining({
      path: ['ADMIN_AMOUNT_MAX_INTEGER_DIGITS'],
      code: 'custom',
    }),
  ]);
  expect(
    apiEnvironmentSchema.parse({ ...env, ADMIN_AMOUNT_MAX_INTEGER_DIGITS: '3' })
      .ADMIN_AMOUNT_MAX_INTEGER_DIGITS,
  ).toBe(3);
});

test('framework not-found and request parsing failures use contract envelopes', async () => {
  const missing = await app.inject('/api/does-not-exist');
  expect(missing.statusCode).toBe(404);
  expect(apiErrorSchema.parse(missing.json()).error.code).toBe('NOT_FOUND');
  for (const [contentType, payload] of [
    ['application/octet-stream', 'not-json'],
    ['application/json', '{'],
    ['application/json', 'x'.repeat(1024 * 1024 + 1)],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': contentType },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe(
      'VALIDATION_ERROR',
    );
    expect(response.headers['cache-control']).toBe('no-store');
  }
});

test('new tenant and balance routes require a session before business reads', async () => {
  const tenantId = 'd5f4c9b1-5c5e-4454-8a5b-8f8f73f6d944';
  const path = `/api/admin/tenants/${tenantId}`;
  for (const [method, url, payload] of [
    ['GET', '/api/admin/tenants', undefined],
    ['GET', path, undefined],
    ['GET', path + '/ledger', undefined],
    [
      'POST',
      '/api/admin/tenants',
      {
        code: 'SESSIONPROBE',
        name: 'probe',
        currency: 'CNY',
        settings: { lowBalanceThreshold: '10' },
        initialRates: { kind: 'blank' },
      },
    ],
    [
      'POST',
      path + '/edit',
      { name: 'probe', contactName: '', contactPhone: '', remark: '' },
    ],
    ['POST', path + '/disable', undefined],
    ['POST', path + '/enable', undefined],
    [
      'POST',
      path + '/settings',
      { overdraftLimit: '100', lowBalanceThreshold: '10', emails: [] },
    ],
    [
      'POST',
      path + '/balance-operations',
      {
        kind: 'adjustment',
        amount: '-1.0001',
        reason: '冲正',
        currency: 'CNY',
        idempotencyKey: 'manual:session-probe',
      },
    ],
  ] as const) {
    const response = await app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe(
      'UNAUTHENTICATED',
    );
    expect(response.headers['cache-control']).toBe('no-store');
  }
});

test('tenant CSV upload boundary honors two decoded MiB and maps excess size to the CSV contract', async () => {
  const body = {
    code: 'CSVPROBE',
    name: 'probe',
    currency: 'CNY',
    settings: { lowBalanceThreshold: '10' },
  };
  const request = (size: number) =>
    app.inject({
      method: 'POST',
      url: '/api/admin/tenants',
      payload: {
        ...body,
        initialRates: {
          kind: 'csv',
          file: {
            filename: 'rates.csv',
            contentBase64: Buffer.alloc(size, 10).toString('base64'),
          },
        },
      },
    });
  expect((await request(2 * 1024 * 1024)).statusCode).toBe(401);
  const over = await request(2 * 1024 * 1024 + 1);
  expect(over.statusCode, over.body).toBe(413);
  expect(over.json()).toMatchObject({ error: { code: 'CSV_LIMIT_EXCEEDED' } });
  const transport = await request(3 * 1024 * 1024);
  expect(transport.statusCode, transport.body).toBe(413);
  expect(transport.json()).toMatchObject({
    error: { code: 'CSV_LIMIT_EXCEEDED' },
  });
});
