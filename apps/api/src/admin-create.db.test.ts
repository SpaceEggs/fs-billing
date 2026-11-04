import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { expect, inject, it } from 'vitest';
import { sessionResponseSchema } from '@fs-billing/shared';
import {
  apiConnections,
  fixtureApi,
  origin,
  type ApiConnections,
} from '../test/support.js';
import { adminCreateActorLabel, createAdmin } from './auth/admin-create.js';

const connections: ApiConnections = apiConnections();
const { api } = fixtureApi(connections);

const actorLabel = `cli:admin:create@${hostname()}/${userInfo().username}`;
const uniqueEmail = () => `first-admin-${randomUUID()}@example.com`;

async function loginWith(email: string, password: string) {
  return api.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { origin },
    payload: { email, password },
  });
}

it('creates the auth user, admin profile and temporary credential, and audits it', async () => {
  const email = uniqueEmail();
  const password = 'Admin-create-password-47';
  expect(adminCreateActorLabel()).toBe(actorLabel);
  const created = await createAdmin({
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    email: email.toUpperCase(),
    name: '首个管理员',
    password,
  });
  const profile = await connections.owner.pool.query<{
    email: string;
    name: string;
    status: string;
  }>(
    `SELECT u.email,a.name,a.status FROM public.admins a
     JOIN auth."user" u ON u.id=a.auth_user_id WHERE a.id=$1`,
    [created.profileId],
  );
  expect(profile.rows).toEqual([
    { email, name: '首个管理员', status: 'active' },
  ]);
  const credential = await connections.owner.pool.query<{
    temporary_password_issued_at: Date | null;
    password: string;
  }>(
    `SELECT temporary_password_issued_at,password FROM auth.account
     WHERE user_id=$1 AND provider_id='credential'`,
    [created.userId],
  );
  expect(credential.rows[0]?.temporary_password_issued_at).toBeInstanceOf(Date);
  expect(credential.rows[0]?.password).not.toBe(password);

  const audit = await connections.owner.pool.query<{
    admin_id: string | null;
    actor_label: string;
    tenant_id: string | null;
    action: string;
    target: string;
    details: {
      actor: { label: string };
      target: { kind: string; id: string };
      content: Record<string, unknown>;
    };
  }>(
    `SELECT admin_id,actor_label,tenant_id,action,target,details
     FROM public.operation_logs WHERE id=$1`,
    [created.auditId],
  );
  expect(audit.rows[0]).toMatchObject({
    admin_id: null,
    actor_label: actorLabel,
    tenant_id: null,
    action: 'credential_bootstrap',
    target: created.profileId,
    details: {
      actor: { label: actorLabel },
      target: { kind: 'admin', id: created.profileId },
      content: {
        summary: '创建管理员「首个管理员」',
        changes: [],
        mode: 'create',
        result: 'succeeded',
        errorCode: null,
        revokedSessions: 0,
      },
    },
  });

  const signed = await loginWith(email, password);
  expect(signed.statusCode).toBe(200);
  expect(
    sessionResponseSchema.parse(signed.json()).passwordChangeRequired,
  ).toBe(true);
});

it('refuses duplicate emails, weak passwords and non-owner connections without writing', async () => {
  const email = uniqueEmail();
  const password = 'Admin-create-password-47';
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    email,
    name: '首个管理员',
    password,
  };
  await createAdmin(input);
  const auditsBefore = (
    await connections.owner.pool.query<{ count: string }>(
      'SELECT count(*) FROM public.operation_logs WHERE actor_label=$1',
      [actorLabel],
    )
  ).rows[0]!.count;

  await expect(createAdmin({ ...input, name: '另一个管理员' })).rejects.toThrow(
    'An account with this email already exists',
  );
  await expect(
    createAdmin({ ...input, email: uniqueEmail(), password: 'short' }),
  ).rejects.toThrow('Password does not meet the shared password rules');
  for (const pool of [connections.app.pool, connections.authPool]) {
    await expect(createAdmin({ ...input, pool })).rejects.toThrow(
      'Admin creation requires owner DATABASE_URL',
    );
  }
  const users = await connections.owner.pool.query<{ count: string }>(
    'SELECT count(*) FROM auth."user" WHERE email=$1',
    [email],
  );
  expect(users.rows[0]?.count).toBe('1');
  const auditsAfter = (
    await connections.owner.pool.query<{ count: string }>(
      'SELECT count(*) FROM public.operation_logs WHERE actor_label=$1',
      [actorLabel],
    )
  ).rows[0]!.count;
  expect(auditsAfter).toBe(auditsBefore);
});

it('admin:create CLI prints the generated password once and forces a change on first login', async () => {
  const email = uniqueEmail();
  const result = await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/admin-create.ts',
          '--email',
          email,
          '--name',
          '命令行管理员',
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: inject('ownerUrl'),
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters',
          },
        },
        (error, stdout, stderr) => {
          if (error)
            reject(new Error('admin:create CLI failed', { cause: error }));
          else resolve({ stdout, stderr });
        },
      );
    },
  );
  expect(result.stderr).toBe('');
  expect(result.stdout).toMatch(/^[A-Za-z0-9_-]{32}\n$/);
  const signed = await loginWith(email, result.stdout.trim());
  expect(signed.statusCode).toBe(200);
  expect(
    sessionResponseSchema.parse(signed.json()).passwordChangeRequired,
  ).toBe(true);
  const audits = await connections.owner.pool.query<{ actor_label: string }>(
    `SELECT actor_label FROM public.operation_logs
     WHERE action='credential_bootstrap' AND details->'target'->>'id'=(
       SELECT id::text FROM public.admins WHERE auth_user_id=(
         SELECT id FROM auth."user" WHERE email=$1))`,
    [email],
  );
  expect(audits.rows).toEqual([{ actor_label: actorLabel }]);
});

it('admin:create CLI rejects a non-owner connection before creating anything', async () => {
  await expect(
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/admin-create.ts',
          '--email',
          uniqueEmail(),
          '--name',
          '拒绝管理员',
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: inject('appUrl'),
            BETTER_AUTH_URL: origin,
            BETTER_AUTH_SECRET: 'test-only-secret-with-at-least-32-characters',
          },
        },
        (error, stdout, stderr) => {
          if (error)
            reject(
              Object.assign(new Error('admin:create CLI failed'), {
                code: error.code,
                stdout,
                stderr,
              }),
            );
          else resolve({ stdout, stderr });
        },
      );
    }),
  ).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: 'Admin creation requires owner DATABASE_URL\n',
  });
});
