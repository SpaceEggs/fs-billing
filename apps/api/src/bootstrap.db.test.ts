import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { beforeEach, expect, inject, it } from 'vitest';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  password,
  type Fixture,
} from '../test/support.js';
import { bootstrapCredential } from './auth/bootstrap.js';

const connections = apiConnections();
const { api } = fixtureApi(connections);
let fixture: Fixture;
beforeEach(async () => {
  fixture = await createFixture(connections);
});

it.each(['admin', 'portal'] as const)(
  'bootstraps a migrated %s profile through the installed Better Auth password hasher',
  async (kind) => {
    const user = kind === 'admin' ? fixture.admin : fixture.a;
    await connections.owner.pool.query(
      'DELETE FROM auth.account WHERE user_id=$1',
      [user.userId],
    );
    await bootstrapCredential({
      pool: connections.owner.pool,
      auth: connections.betterAuth,
      kind,
      profileId: user.profileId,
      password: 'Bootstrap-password-47',
      replace: false,
    });
    await login(api, user, 'Bootstrap-password-47');
    const credentials = await connections.owner.pool.query(
      'SELECT account_id,provider_id FROM auth.account WHERE user_id=$1',
      [user.userId],
    );
    expect(credentials.rows).toEqual([
      { account_id: user.userId, provider_id: 'credential' },
    ]);
  },
);

it('refuses an existing credential and replaces it only with explicit session revocation', async () => {
  const current = await login(api, fixture.a);
  const other = await login(api, fixture.b);
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    kind: 'portal' as const,
    profileId: fixture.a.profileId,
    password: 'Replacement-password-47',
    replace: false,
  };
  await expect(bootstrapCredential(input)).rejects.toThrow('Credential exists');
  await login(api, fixture.a, password);
  await bootstrapCredential({ ...input, replace: true });
  expect(
    (
      await api.inject({
        url: '/api/auth/session',
        headers: { cookie: current.cookie },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (
      await api.inject({
        url: '/api/auth/session',
        headers: { cookie: other.cookie },
      })
    ).statusCode,
  ).toBe(200);
  await login(api, fixture.a, input.password);
  const sessions = await connections.owner.pool.query(
    'SELECT token FROM auth.session WHERE user_id=$1',
    [fixture.a.userId],
  );
  expect(sessions.rows).toHaveLength(1);
});

it('serializes concurrent initializations and refuses unknown profiles and runtime roles', async () => {
  await connections.owner.pool.query(
    'DELETE FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    kind: 'portal' as const,
    profileId: fixture.a.profileId,
    password: 'Bootstrap-password-47',
    replace: false,
  };
  const results = await Promise.allSettled([
    bootstrapCredential(input),
    bootstrapCredential(input),
  ]);
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(
    1,
  );
  await login(api, fixture.a, input.password);
  await expect(
    bootstrapCredential({ ...input, kind: 'admin' }),
  ).rejects.toThrow('Profile not found');
  for (const pool of [connections.app.pool, connections.authPool]) {
    await expect(bootstrapCredential({ ...input, pool })).rejects.toThrow(
      'requires owner',
    );
  }
});

it('rolls back the credential update and counter cleanup when session revocation fails', async () => {
  const current = await login(api, fixture.a);
  const name = `bootstrap_failure_${randomUUID().replaceAll('-', '')}`;
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    kind: 'portal' as const,
    profileId: fixture.a.profileId,
    password: 'Never-committed-password-47',
    replace: true,
  };
  await connections.owner.pool.query(
    'INSERT INTO auth.login_failures(email_key,window_id,failed_count,last_failed_at) VALUES($1,gen_random_uuid(),1,now())',
    [fixture.a.email],
  );
  await connections.owner.pool.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.user_id=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected bootstrap revocation failure'; END IF; RETURN OLD; END $$`,
  );
  try {
    await connections.owner.pool.query(
      `CREATE TRIGGER ${name} BEFORE DELETE ON auth.session FOR EACH ROW EXECUTE FUNCTION public.${name}('${fixture.a.userId}')`,
    );
    await expect(bootstrapCredential(input)).rejects.toThrow(
      'Injected bootstrap revocation failure',
    );
  } finally {
    await connections.owner.pool.query(
      `DROP TRIGGER IF EXISTS ${name} ON auth.session`,
    );
    await connections.owner.pool.query(`DROP FUNCTION public.${name}()`);
  }
  const failures = await connections.owner.pool.query(
    'SELECT failed_count FROM auth.login_failures WHERE email_key=$1',
    [fixture.a.email],
  );
  expect(failures.rows).toEqual([{ failed_count: 1 }]);
  expect(
    (
      await api.inject({
        url: '/api/auth/session',
        headers: { cookie: current.cookie },
      })
    ).statusCode,
  ).toBe(200);
  await login(api, fixture.a, password);
});

it('CLI prints generated secrets once after success and never echoes stdin passwords', async () => {
  async function run(args: string[], stdin = '') {
    return new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = execFile(
          process.execPath,
          [
            '--import',
            'tsx',
            'scripts/bootstrap-credential.ts',
            '--kind',
            'portal',
            '--profile',
            fixture.a.profileId,
            ...args,
          ],
          {
            cwd: new URL('../', import.meta.url),
            env: {
              ...process.env,
              DATABASE_URL: inject('ownerUrl'),
              BETTER_AUTH_URL: 'http://localhost:3000',
              BETTER_AUTH_SECRET:
                'test-only-secret-with-at-least-32-characters',
            },
          },
          (error, stdout, stderr) => {
            if (error)
              reject(new Error('Bootstrap CLI failed', { cause: error }));
            else resolve({ stdout, stderr });
          },
        );
        child.stdin?.end(stdin);
      },
    );
  }
  await connections.owner.pool.query(
    'DELETE FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const generated = await run(['--generate']);
  expect(generated.stderr).toBe('');
  expect(generated.stdout).toMatch(/^[A-Za-z0-9_-]{32}\n$/);
  await login(api, fixture.a, generated.stdout.trim());
  const provided = 'Stdin-bootstrap-password-47';
  expect(await run(['--replace'], `${provided}\n`)).toEqual({
    stdout: 'Credential initialized.\n',
    stderr: '',
  });
  await login(api, fixture.a, provided);
});

const exec = promisify(execFile);

it('bootstrap CLI rejects password arguments without echoing their values', async () => {
  const secret = 'Must-never-appear-argument-secret';
  await expect(
    exec(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/bootstrap-credential.ts',
        `--password=${secret}`,
      ],
      { cwd: new URL('../', import.meta.url) },
    ),
  ).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr:
      'Use --kind admin|portal --profile UUID [--replace] [--generate]. Passwords must come from stdin.\n',
  });
});

it.each(['fs_billing_app', 'fs_billing_auth'])(
  'bootstrap CLI refuses %s before reading a password or connecting',
  async (role) => {
    await expect(
      exec(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/bootstrap-credential.ts',
          '--kind',
          'admin',
          '--profile',
          '11111111-1111-4111-8111-111111111111',
          '--generate',
        ],
        {
          cwd: new URL('../', import.meta.url),
          env: {
            ...process.env,
            DATABASE_URL: `postgresql://${role}@localhost/db`,
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stdout: '',
      stderr: 'Credential bootstrap requires owner DATABASE_URL\n',
    });
  },
);
