import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { adminLedgerResponseSchema } from '@fs-billing/shared';
import type { Db } from '@fs-billing/db';
import { createApi } from '../src/app.js';
import { createAuthGateway } from '../src/auth/gateway.js';

/** Real loopback HTTP, cookie authentication and app-role business queries. */
export async function measureAdminLedgerHttp({
  db,
  owner,
  authUrl,
  tenantId,
  rounds,
}: {
  db: Db;
  owner: pg.Client;
  authUrl: string;
  tenantId: string;
  rounds: number;
}) {
  const authPool = new pg.Pool({ connectionString: authUrl, max: 1 });
  const secret = randomBytes(32).toString('base64url');
  const token = randomBytes(32).toString('base64url');
  const auth = createAuthGateway({
    pool: authPool,
    secret,
    baseURL: 'http://localhost:3000',
    secureCookies: false,
    trustedOrigins: ['http://localhost:3000'],
    logger: { info: () => undefined, error: () => undefined },
  });
  const api = createApi({ businessDb: db, auth });
  try {
    const { rows } = await owner.query<{ auth_user_id: string }>(
      "select auth_user_id from admins where status='active' order by id limit 1",
    );
    const userId = rows[0]?.auth_user_id;
    assert(userId, 'seeded administrator required');
    await authPool.query(
      `insert into auth.session(id,token,user_id,expires_at,created_at,updated_at) values($1,$2,$3,clock_timestamp()+interval '1 hour',clock_timestamp(),clock_timestamp())`,
      [randomUUID(), token, userId],
    );
    const signature = createHmac('sha256', secret)
      .update(token)
      .digest('base64');
    const cookie = `better-auth.session_token=${encodeURIComponent(`${token}.${signature}`)}`;
    const address = await api.listen({ host: '127.0.0.1', port: 0 });
    const samples: {
      month: string;
      ms: number;
      status: number;
      bytes: number;
      total: number;
      items: number;
    }[] = [];
    // Page-size 50 matches the historical 54-second query. Include the historical middle month.
    for (let round = -2; round < rounds; round++) {
      const months =
        round % 2 ? ['2026-04', '2026-09'] : ['2026-09', '2026-04'];
      for (const month of months) {
        const started = performance.now();
        const response = await fetch(
          `${address}/api/admin/tenants/${tenantId}/ledger?from=${month}-01&to=${month}-30&pageSize=50`,
          { headers: { cookie } },
        );
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const body = adminLedgerResponseSchema.parse(JSON.parse(text));
        assert(
          body.items.length >= 30 && body.pagination.total >= 30,
          'full merged month must be consumed',
        );
        if (round >= 0)
          samples.push({
            month,
            ms: Number((performance.now() - started).toFixed(1)),
            status: response.status,
            bytes: Buffer.byteLength(text),
            total: body.pagination.total,
            items: body.items.length,
          });
      }
    }
    return {
      transport:
        'loopback HTTP fetch, real cookie gateway, app business role and auth role, response consumed and schema parsed',
      pageSize: 50,
      warmups: 2,
      rounds,
      samples,
      errors: 0,
    };
  } finally {
    await api.close();
    await authPool.query('delete from auth.session where token=$1', [token]);
    await authPool.end();
  }
}
