import pg from 'pg';
import { afterAll, expect, test, vi } from 'vitest';
import { connect } from '@fs-billing/db';
import { apiErrorSchemas } from '@fs-billing/shared';
import { createApi } from './app.js';
import { createAuthGateway } from './auth/gateway.js';
import * as identity from './identity.js';
import { principalSchema } from './types.js';

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
const profileId = '11111111-1111-4111-8111-111111111111';
const principal = principalSchema.parse({
  kind: 'admin',
  authUserId: 'test-admin',
  profileId,
});
if (principal.kind !== 'admin') throw new Error('Expected admin principal');

afterAll(async () => {
  await Promise.all([business.pool.end(), pool.end()]);
});

test.each([
  { method: 'GET', url: '/api/admin/admins' },
  {
    method: 'POST',
    url: `/api/admin/portal-accounts/${profileId}/reset-password`,
  },
  { method: 'POST', url: `/api/admin/admins/${profileId}/reset-password` },
] as const)(
  'missing account service returns 503 for $method $url',
  async (request) => {
    const resolved = vi.spyOn(identity, 'resolvePrincipal').mockResolvedValue({
      kind: 'admin',
      principal,
      identity: {
        kind: 'admin',
        profileId,
        name: 'Test admin',
        email: 'admin@example.com',
      },
    });
    const app = createApi({
      businessDb: business.db,
      auth: {
        ...auth,
        session: () =>
          Promise.resolve({
            authUserId: principal.authUserId,
            email: 'admin@example.com',
            token: 'test-session',
            expiresAt: new Date('2099-01-01'),
            passwordChangeRequired: false,
          }),
      },
    });
    try {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(503);
      const body = apiErrorSchemas.SERVICE_UNAVAILABLE.parse(response.json());
      expect(body.error).toMatchObject({
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂不可用',
      });
      expect(body.error.requestId).toMatch(/\S+/);
      expect(response.headers['cache-control']).toBe('no-store');
    } finally {
      await app.close();
      resolved.mockRestore();
    }
  },
);
