import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { connect } from '@fs-billing/db';
import {
  DEFAULT_ADMIN_CSV_MAX_BYTES,
  DEFAULT_ADMIN_CSV_BODY_LIMIT,
  apiErrorSchema,
  createAdminRateRequestSchemas,
} from '@fs-billing/shared';
import { principalSchema } from './types.js';
import { rateHandlers } from './routes/admin/rates.js';
import { ApiFailure } from './errors.js';
import { createApi } from './app.js';
import { createAuthGateway } from './auth/gateway.js';

const business = connect('postgresql://fs_billing_app@127.0.0.1/fs_billing');
const pool = new pg.Pool();
const auth = createAuthGateway({
  pool,
  secret: 'rates-http-test-secret-at-least-32-characters',
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
const tenantId = randomUUID();
const versionId = randomUUID();
const path = `/api/admin/tenants/${tenantId}/rates`;

it('rates require authenticated admin access before any business reads', async () => {
  for (const [method, suffix, payload] of [
    ['GET', '', undefined],
    [
      'POST',
      '/edit-entry',
      {
        baseVersionId: versionId,
        entry: {
          iso: '',
          description: '',
          prefix: '1',
          country: '美国',
          rate: '0.0001',
        },
        schedule: { kind: 'immediate' },
      },
    ],
    [
      'POST',
      '/import/preview',
      {
        baseVersionId: versionId,
        file: {
          filename: 'rates.csv',
          contentBase64: Buffer.from(
            'ISO,国家,号码前缀,说明,费率\n,美国,1,,0.1',
          ).toString('base64'),
        },
        schedule: { kind: 'immediate' },
      },
    ],
    ['POST', '/import/commit', { previewId: randomUUID() }],
    ['POST', '/export', { versionId }],
    [
      'POST',
      '/copy/preview',
      {
        sourceVersionId: versionId,
        targetTenantId: randomUUID(),
        targetBaseVersionId: randomUUID(),
        schedule: { kind: 'immediate' },
      },
    ],
    ['POST', '/copy/commit', { previewId: randomUUID() }],
    ['POST', '/cancel-future-version', { versionId }],
  ] as const) {
    const response = await app.inject({
      method,
      url: path + suffix,
      ...(payload ? { payload } : {}),
    });
    expect(response.statusCode, response.body).toBe(401);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe(
      'UNAUTHENTICATED',
    );
    expect(response.headers['cache-control']).toBe('no-store');
  }
});

it('rates reject untrusted export origins and invalid edit precision using contract errors', async () => {
  const exportResponse = await app.inject({
    method: 'POST',
    url: path + '/export',
    headers: { origin: 'https://attacker.example' },
    payload: { versionId },
  });
  expect(exportResponse.statusCode).toBe(403);
  expect(apiErrorSchema.parse(exportResponse.json()).error.code).toBe(
    'FORBIDDEN',
  );
  for (const rate of ['-1', '0.00001', '1e-4']) {
    const response = await app.inject({
      method: 'POST',
      url: path + '/edit-entry',
      payload: {
        baseVersionId: versionId,
        entry: { iso: '', description: '', prefix: '1', country: '美国', rate },
        schedule: { kind: 'immediate' },
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(apiErrorSchema.parse(response.json()).error.code).toBe(
      'VALIDATION_ERROR',
    );
  }
});

it('rate import honors decoded CSV size and maps excessive transport size', async () => {
  const request = (size: number) =>
    app.inject({
      method: 'POST',
      url: path + '/import/preview',
      payload: {
        baseVersionId: versionId,
        file: {
          filename: 'rates.csv',
          contentBase64: Buffer.alloc(size, 10).toString('base64'),
        },
        schedule: { kind: 'immediate' },
      },
    });
  const atLimit = await request(DEFAULT_ADMIN_CSV_MAX_BYTES);
  expect(atLimit.statusCode, atLimit.body).toBe(401);
  for (const size of [
    DEFAULT_ADMIN_CSV_MAX_BYTES + 1,
    DEFAULT_ADMIN_CSV_BODY_LIMIT,
  ]) {
    const response = await request(size);
    expect(response.statusCode, response.body).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'CSV_LIMIT_EXCEEDED' },
    });
  }
});

it('CSV transport limit accepts the exact shared boundary and rejects one extra byte', async () => {
  const json = JSON.stringify({
    baseVersionId: versionId,
    file: { filename: 'rates.csv', contentBase64: 'MQ==' },
    schedule: { kind: 'immediate' },
  });
  for (const extra of [0, 1]) {
    const response = await app.inject({
      method: 'POST',
      url: path + '/import/preview',
      headers: { 'content-type': 'application/json' },
      payload:
        json + ' '.repeat(DEFAULT_ADMIN_CSV_BODY_LIMIT - json.length + extra),
    });
    expect(response.statusCode, response.body).toBe(extra === 0 ? 401 : 413);
    expect(response.json()).toMatchObject({
      error: { code: extra === 0 ? 'UNAUTHENTICATED' : 'CSV_LIMIT_EXCEEDED' },
    });
  }
});

it('configured horizon governs edit, import and copy at the HTTP boundary', async () => {
  const configured = createApi({
    businessDb: business.db,
    auth,
    adminRates: { horizonMs: 60_000 },
  });
  try {
    const schedule = {
      kind: 'scheduled',
      effectiveFrom: new Date(Date.now() + 120_000).toISOString(),
    };
    for (const [suffix, payload] of [
      [
        '/edit-entry',
        {
          baseVersionId: versionId,
          entry: {
            iso: '',
            description: '',
            prefix: '1',
            country: '美国',
            rate: '0.0001',
          },
          schedule,
        },
      ],
      [
        '/import/preview',
        {
          baseVersionId: versionId,
          file: {
            filename: 'rates.csv',
            contentBase64: Buffer.from(',美国,1,,0.1').toString('base64'),
          },
          schedule,
        },
      ],
      [
        '/copy/preview',
        {
          sourceVersionId: versionId,
          targetTenantId: randomUUID(),
          targetBaseVersionId: randomUUID(),
          schedule,
        },
      ],
    ] as const) {
      const response = await configured.inject({
        method: 'POST',
        url: path + suffix,
        payload,
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(apiErrorSchema.parse(response.json()).error.code).toBe(
        'VALIDATION_ERROR',
      );
    }
  } finally {
    await configured.close();
  }
});

it('an edit schedule that expires after initial validation stays a validation error', async () => {
  const initialTime = Date.now();
  const rateRequests = createAdminRateRequestSchemas();
  const payload = rateRequests.editRequest.parse({
    baseVersionId: versionId,
    entry: {
      iso: '',
      description: '',
      prefix: '1',
      country: '美国',
      rate: '0.0001',
    },
    schedule: {
      kind: 'scheduled',
      effectiveFrom: new Date(initialTime + 60_000).toISOString(),
    },
  });
  const principal = principalSchema.parse({
    kind: 'admin',
    authUserId: 'admin-test',
    profileId: randomUUID(),
  });
  if (principal.kind !== 'admin') throw new Error('Expected admin principal');
  const isolated = Fastify();
  const handlers = rateHandlers(business.db, { rateRequests });
  isolated.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiFailure)
      return reply.code(400).send({ code: error.code });
    return reply.code(503).send({ code: 'SERVICE_UNAVAILABLE' });
  });
  isolated.post('/expired-schedule/:tenantId', (request, reply) =>
    handlers.adminRateEdit(
      {
        kind: 'admin',
        principal,
        identity: {
          kind: 'admin',
          profileId: principal.profileId,
          name: 'Admin',
          email: 'admin@example.com',
        },
        session: {
          authUserId: principal.authUserId,
          email: 'admin@example.com',
          token: 'test-session',
          expiresAt: new Date(initialTime + 3_600_000),
          passwordChangeRequired: false,
        },
      },
      request,
      reply,
    ),
  );
  const time = vi.spyOn(Date, 'now').mockReturnValue(initialTime + 120_000);
  try {
    const response = await isolated.inject({
      method: 'POST',
      url: `/expired-schedule/${tenantId}`,
      payload,
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({ code: 'VALIDATION_ERROR' });
  } finally {
    time.mockRestore();
    await isolated.close();
  }
});
