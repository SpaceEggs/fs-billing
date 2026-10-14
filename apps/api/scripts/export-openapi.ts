import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { connect } from '@fs-billing/db';
import { createApi } from '../src/app.js';
import { createAuthGateway } from '../src/auth/gateway.js';
import { generateOpenApi } from '../src/openapi.js';

const business = connect('postgresql://fs_billing_app@localhost/fs_billing');
const pool = new pg.Pool();
const auth = createAuthGateway({
  pool,
  secret: 'openapi-export-only-not-a-runtime-secret',
  baseURL: 'http://localhost:3000',
  secureCookies: false,
  trustedOrigins: ['http://localhost:3000'],
  logger: { info() {}, error() {} },
});
const app = createApi({ businessDb: business.db, auth });
try {
  const { document, operations } = await generateOpenApi(app);
  await writeFile(
    process.argv[2] ?? 'openapi.json',
    `${JSON.stringify(document, null, 2)}\n`,
  );
  process.stdout.write(`${operations.length} contract operations exported\n`);
} finally {
  await app.close();
  await Promise.all([business.pool.end(), pool.end()]);
}
