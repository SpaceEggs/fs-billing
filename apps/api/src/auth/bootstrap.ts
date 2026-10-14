import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { newPasswordSchema } from '@fs-billing/shared';
import type { BillingAuth } from './better-auth.js';
import { assertAuthOptions } from './better-auth.js';
import { normalizeEmail } from './gateway.js';

export async function bootstrapCredential(input: {
  pool: Pool;
  auth: BillingAuth;
  kind: 'admin' | 'portal';
  profileId: string;
  password: string;
  replace: boolean;
}) {
  const client = await input.pool.connect();
  try {
    const role = await client.query<{ role: string }>(
      'SELECT current_user AS role',
    );
    if (
      ['fs_billing_app', 'fs_billing_auth', 'fs_billing_identity'].includes(
        role.rows[0]?.role ?? '',
      )
    )
      throw new Error('Credential bootstrap requires owner DATABASE_URL');
    // Never include Zod input values in a password validation error.
    if (!newPasswordSchema.safeParse(input.password).success)
      throw new Error('Password does not meet the shared password rules');
    const context = await input.auth.$context;
    assertAuthOptions(context.options);
    const hash = await context.password.hash(input.password);
    await client.query('BEGIN');
    const table = input.kind === 'admin' ? 'admins' : 'portal_accounts';
    const target = await client.query<{ id: string; email: string }>(
      `SELECT u.id,u.email FROM public.${table} p JOIN auth."user" u ON u.id=p.auth_user_id WHERE p.id=$1 FOR NO KEY UPDATE OF u`,
      [input.profileId],
    );
    const user = target.rows[0];
    if (!user) throw new Error('Profile not found');
    const credentials = await client.query<{ id: string }>(
      "SELECT id FROM auth.account WHERE user_id=$1 AND provider_id='credential' FOR UPDATE",
      [user.id],
    );
    if (credentials.rows.length > 1)
      throw new Error('Multiple credential accounts require repair');
    const existing = credentials.rows[0];
    if (existing && !input.replace)
      throw new Error(
        'Credential exists; use --replace to revoke sessions and replace it',
      );
    if (existing) {
      await client.query(
        'UPDATE auth.account SET password=$1,updated_at=clock_timestamp() WHERE id=$2',
        [hash, existing.id],
      );
    } else {
      await client.query(
        "INSERT INTO auth.account(id,account_id,provider_id,user_id,password,updated_at) VALUES($1,$2,'credential',$2,$3,clock_timestamp())",
        [randomUUID(), user.id, hash],
      );
    }
    if (input.replace)
      await client.query('DELETE FROM auth.session WHERE user_id=$1', [
        user.id,
      ]);
    await client.query('DELETE FROM auth.login_failures WHERE email_key=$1', [
      normalizeEmail(user.email),
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
