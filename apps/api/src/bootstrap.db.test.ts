import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { beforeEach, expect, inject, it } from 'vitest';
import {
  apiConnections,
  createFixture,
  fixtureApi,
  login,
  password,
  type Fixture,
} from '../test/support.js';
import { bootstrapActorLabel, bootstrapCredential } from './auth/bootstrap.js';

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
  // 命令行自己写审计（阶段 8）：来源是运行它的主机与系统用户，没有密码。
  const audits = (
    await connections.owner.pool.query<{
      actor_label: string;
      details: object;
    }>(
      `SELECT actor_label,details FROM public.operation_logs
       WHERE action='credential_bootstrap' AND target=$1 ORDER BY created_at,id`,
      [fixture.a.profileId],
    )
  ).rows;
  expect(audits.map((audit) => audit.actor_label)).toEqual([
    `cli:auth:bootstrap@${hostname()}/${userInfo().username}`,
    `cli:auth:bootstrap@${hostname()}/${userInfo().username}`,
  ]);
  expect(JSON.stringify(audits)).not.toContain(provided);
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

/**
 * 阶段 8 延后项 2（决定 41）：bootstrap 的审计。操作者是 actor_label（没有管理员），
 * 成功时与凭据、会话撤销同一个事务；拒绝与失败在回滚后另写一条，内容里没有密码、哈希、会话 token。
 */
type BootstrapLog = {
  id: string;
  admin_id: string | null;
  actor_label: string | null;
  tenant_id: string | null;
  target: string;
  created_at: Date;
  details: {
    actor: { label: string };
    target: { kind: string; id: string };
    content: Record<string, unknown>;
  };
};
const bootstrapLogs = async (profileId: string) =>
  (
    await connections.owner.pool.query<BootstrapLog>(
      `SELECT id,admin_id,actor_label,tenant_id,target,created_at,details FROM public.operation_logs
       WHERE action='credential_bootstrap' AND target=$1 ORDER BY created_at,id`,
      [profileId],
    )
  ).rows;
const label = `cli:auth:bootstrap@${hostname()}/${userInfo().username}`;

it('audits a created and a replaced credential in the same transaction', async () => {
  const session = await login(api, fixture.a);
  await login(api, fixture.a);
  await connections.owner.pool.query(
    'DELETE FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    kind: 'portal' as const,
    profileId: fixture.a.profileId,
    password: 'Audited-password-47',
    replace: false,
  };
  expect(bootstrapActorLabel()).toBe(label);
  await bootstrapCredential(input);
  await bootstrapCredential({
    ...input,
    password: 'Audited-replacement-47',
    replace: true,
  });
  const [created, replaced, ...rest] = await bootstrapLogs(fixture.a.profileId);
  expect(rest).toEqual([]);
  expect(created).toMatchObject({
    admin_id: null,
    actor_label: label,
    tenant_id: fixture.a.tenantId,
    target: fixture.a.profileId,
    details: {
      actor: { label },
      target: { kind: 'portal_account', id: fixture.a.profileId },
      content: {
        mode: 'create',
        result: 'succeeded',
        errorCode: null,
        revokedSessions: 0,
      },
    },
  });
  // 替换撤销了此前登录的两个会话，数量如实记录。
  expect(replaced?.details.content).toMatchObject({
    mode: 'replace',
    result: 'succeeded',
    errorCode: null,
    revokedSessions: 2,
  });
  expect(
    (
      await api.inject({
        url: '/api/auth/session',
        headers: { cookie: session.cookie },
      })
    ).statusCode,
  ).toBe(401);
  // 又有两个会话时再替换一次：撤销数量等于被删的会话行数。
  await login(api, fixture.a, 'Audited-replacement-47');
  await login(api, fixture.a, 'Audited-replacement-47');
  await bootstrapCredential({
    ...input,
    password: 'Audited-third-password-47',
    replace: true,
  });
  const third = (await bootstrapLogs(fixture.a.profileId)).at(-1);
  expect(third?.details.content).toMatchObject({
    mode: 'replace',
    result: 'succeeded',
    revokedSessions: 2,
  });
  expect(third?.details.content['summary']).toContain('2');
});

it('writes the credential, the session revocation and the audit in one transaction', async () => {
  await connections.owner.pool.query(
    'DELETE FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const name = `bootstrap_audit_failure_${randomUUID().replaceAll('-', '')}`;
  await connections.owner.pool.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='credential_bootstrap' AND NEW.target='${fixture.a.profileId}' THEN RAISE EXCEPTION 'Injected bootstrap audit failure'; END IF; RETURN NEW; END $$`,
  );
  const warnings: string[] = [];
  try {
    await connections.owner.pool.query(
      `CREATE TRIGGER ${name} BEFORE INSERT ON public.operation_logs FOR EACH ROW EXECUTE FUNCTION public.${name}()`,
    );
    await expect(
      bootstrapCredential({
        pool: connections.owner.pool,
        auth: connections.betterAuth,
        kind: 'portal',
        profileId: fixture.a.profileId,
        password: 'Never-committed-audit-47',
        replace: false,
        warn: (message) => warnings.push(message),
      }),
    ).rejects.toThrow('Injected bootstrap audit failure');
  } finally {
    await connections.owner.pool.query(
      `DROP TRIGGER IF EXISTS ${name} ON public.operation_logs`,
    );
    await connections.owner.pool.query(`DROP FUNCTION public.${name}()`);
  }
  // 审计写不进去，凭据也没有创建；失败的审计尽力而为，写不进去只提示，原错误不变。
  expect(
    (
      await connections.owner.pool.query(
        'SELECT id FROM auth.account WHERE user_id=$1',
        [fixture.a.userId],
      )
    ).rows,
  ).toEqual([]);
  expect(await bootstrapLogs(fixture.a.profileId)).toEqual([]);
  expect(warnings).toEqual(['审计未写入']);
});

it('audits a rejected attempt and an unexpected failure with a fixed error code', async () => {
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    kind: 'portal' as const,
    profileId: fixture.a.profileId,
    password: 'Rejected-password-47',
    replace: false,
  };
  const codes = async () =>
    (await bootstrapLogs(fixture.a.profileId)).map((log) => ({
      result: log.details.content['result'],
      errorCode: log.details.content['errorCode'],
      revokedSessions: log.details.content['revokedSessions'],
    }));

  // 凭据已存在而没有 --replace。
  await expect(bootstrapCredential(input)).rejects.toThrow('Credential exists');
  // 密码不符合规则：消息里没有输入。
  await expect(
    bootstrapCredential({ ...input, password: 'short' }),
  ).rejects.toThrow('Password does not meet');
  // 资料不存在（管理员资料里没有这个门户资料）。
  await expect(
    bootstrapCredential({ ...input, kind: 'admin' }),
  ).rejects.toThrow('Profile not found');
  expect(await codes()).toEqual([
    { result: 'rejected', errorCode: 'CREDENTIAL_EXISTS', revokedSessions: 0 },
    { result: 'rejected', errorCode: 'PASSWORD_RULES', revokedSessions: 0 },
    { result: 'rejected', errorCode: 'PROFILE_NOT_FOUND', revokedSessions: 0 },
  ]);
  const logs = await bootstrapLogs(fixture.a.profileId);
  // 拒绝的审计也不挂管理员，操作者是来源标签；资料不存在的那条没有租户（portal 资料不在 admins 里）。
  for (const log of logs) {
    expect(log).toMatchObject({ admin_id: null, actor_label: label });
    expect(log.details.content['mode']).toBe('create');
  }
  expect(logs[2]?.details.target.kind).toBe('admin');

  // 未知失败：会话撤销时数据库报错，回滚后记 failed / UNKNOWN。
  const name = `bootstrap_unknown_${randomUUID().replaceAll('-', '')}`;
  await connections.owner.pool.query(
    `CREATE FUNCTION public.${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.user_id=TG_ARGV[0] THEN RAISE EXCEPTION 'Injected secret-looking failure'; END IF; RETURN OLD; END $$`,
  );
  await login(api, fixture.a);
  try {
    await connections.owner.pool.query(
      `CREATE TRIGGER ${name} BEFORE DELETE ON auth.session FOR EACH ROW EXECUTE FUNCTION public.${name}('${fixture.a.userId}')`,
    );
    await expect(
      bootstrapCredential({ ...input, replace: true }),
    ).rejects.toThrow('Injected secret-looking failure');
  } finally {
    await connections.owner.pool.query(
      `DROP TRIGGER IF EXISTS ${name} ON auth.session`,
    );
    await connections.owner.pool.query(`DROP FUNCTION public.${name}()`);
  }
  const failed = (await bootstrapLogs(fixture.a.profileId)).at(-1);
  expect(failed?.details.content).toMatchObject({
    mode: 'replace',
    result: 'failed',
    errorCode: 'UNKNOWN',
    revokedSessions: 0,
  });
  // 异常消息不进审计。
  expect(JSON.stringify(failed?.details)).not.toContain('secret-looking');
});

it('audit details never contain a password, hash or token', async () => {
  await connections.owner.pool.query(
    'DELETE FROM auth.account WHERE user_id=$1',
    [fixture.a.userId],
  );
  const secret = 'Secret-audited-password-47';
  const input = {
    pool: connections.owner.pool,
    auth: connections.betterAuth,
    kind: 'portal' as const,
    profileId: fixture.a.profileId,
    password: secret,
    replace: false,
  };
  const session = await login(api, fixture.a2);
  await bootstrapCredential(input);
  await expect(bootstrapCredential(input)).rejects.toThrow();
  await bootstrapCredential({ ...input, replace: true });
  const hashes = (
    await connections.owner.pool.query<{ password: string }>(
      'SELECT password FROM auth.account WHERE user_id=$1',
      [fixture.a.userId],
    )
  ).rows.map((row) => row.password);
  const tokens = (
    await connections.owner.pool.query<{ token: string }>(
      'SELECT token FROM auth.session WHERE user_id=$1',
      [fixture.a2.userId],
    )
  ).rows.map((row) => row.token);
  expect(hashes).toHaveLength(1);
  expect(tokens.length).toBeGreaterThan(0);
  const logs = await bootstrapLogs(fixture.a.profileId);
  expect(logs).toHaveLength(3);
  const text = JSON.stringify(logs);
  for (const forbidden of [secret, hashes[0]!, session.cookie, ...tokens])
    expect(text).not.toContain(forbidden);
  expect(text).not.toMatch(/password|hash|token/i);
});
