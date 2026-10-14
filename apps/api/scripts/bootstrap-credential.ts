import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { z } from 'zod';
import { createBetterAuth } from '../src/auth/better-auth.js';
import { bootstrapCredential } from '../src/auth/bootstrap.js';

async function main() {
  let values;
  try {
    values = parseArgs({
      options: {
        kind: { type: 'string' },
        profile: { type: 'string' },
        replace: { type: 'boolean', default: false },
        generate: { type: 'boolean', default: false },
      },
    }).values;
  } catch {
    throw new Error(
      'Use --kind admin|portal --profile UUID [--replace] [--generate]. Passwords must come from stdin.',
    );
  }
  const kind = z.enum(['admin', 'portal']).safeParse(values.kind);
  const profileId = z.uuid().safeParse(values.profile);
  if (!kind.success || !profileId.success)
    throw new Error('A valid profile kind and UUID are required');
  const url = z.url().parse(process.env['DATABASE_URL']);
  if (
    ['fs_billing_app', 'fs_billing_auth', 'fs_billing_identity'].includes(
      decodeURIComponent(new URL(url).username),
    )
  )
    throw new Error('Credential bootstrap requires owner DATABASE_URL');
  let password: string;
  if (values.generate) password = randomBytes(24).toString('base64url');
  else {
    if (process.stdin.isTTY)
      throw new Error('Pipe a password on stdin or use --generate');
    let text = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) text += String(chunk);
    password = text.replace(/\r?\n$/, '');
  }
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
    await bootstrapCredential({
      pool,
      auth,
      kind: kind.data,
      profileId: profileId.data,
      password,
      replace: values.replace,
    });
    process.stdout.write(
      values.generate ? `${password}\n` : 'Credential initialized.\n',
    );
  } finally {
    await pool.end();
  }
}
void main().catch((error: unknown) => {
  // Known operator errors contain no input. Infrastructure errors may contain secrets.
  const message =
    error instanceof Error &&
    /^(Use --kind|A valid profile|Credential bootstrap requires|Pipe a password|Password does not meet|Profile not found|Multiple credential|Credential exists)/.test(
      error.message,
    )
      ? error.message
      : 'Credential bootstrap failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
