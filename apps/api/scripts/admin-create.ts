import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { createBetterAuth } from '../src/auth/better-auth.js';
import { AdminCreateRejection, createAdmin } from '../src/auth/admin-create.js';

const usage =
  'Use --email <address> --name <name>. The temporary password is generated.';

async function main() {
  let values;
  try {
    values = parseArgs({
      options: {
        email: { type: 'string' },
        name: { type: 'string' },
      },
    }).values;
  } catch {
    throw new AdminCreateRejection('INVALID_INPUT', usage);
  }
  if (!values.email || !values.name)
    throw new AdminCreateRejection('INVALID_INPUT', usage);
  const url = z.url().parse(process.env['DATABASE_URL']);
  const password = randomBytes(24).toString('base64url');
  const pool = new pg.Pool({ connectionString: url });
  try {
    const baseURL = z.url().parse(process.env['BETTER_AUTH_URL']);
    const auth = createBetterAuth({
      pool,
      baseURL,
      secret: z.string().min(32).parse(process.env['BETTER_AUTH_SECRET']),
      secureCookies: new URL(baseURL).protocol === 'https:',
      trustedOrigins: [new URL(baseURL).origin],
    });
    await createAdmin({
      pool,
      auth,
      email: values.email,
      name: values.name,
      password,
    });
    process.stdout.write(`${password}\n`);
  } finally {
    await pool.end();
  }
}
void main().catch((error: unknown) => {
  // Known operator errors contain no input. Infrastructure errors may contain secrets.
  const message =
    error instanceof AdminCreateRejection
      ? error.message
      : error instanceof Error &&
          error.message === 'Admin creation requires owner DATABASE_URL'
        ? error.message
        : 'Admin creation failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
