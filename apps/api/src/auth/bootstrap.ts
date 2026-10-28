import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { Pool, PoolClient } from 'pg';
import {
  auditPayloadSchema,
  newPasswordSchema,
  type AuditPayload,
} from '@fs-billing/shared';
import type { BillingAuth } from './better-auth.js';
import { assertAuthOptions } from './better-auth.js';
import { normalizeEmail } from './gateway.js';

type BootstrapAudit = Extract<AuditPayload, { action: 'credential_bootstrap' }>;
type BootstrapErrorCode = NonNullable<BootstrapAudit['content']['errorCode']>;

/** 已知的拒绝：消息里没有输入，可以原样给操作者看；code 进审计，是固定枚举。 */
export class BootstrapRejection extends Error {
  constructor(
    readonly code: Exclude<BootstrapErrorCode, 'UNKNOWN'>,
    message: string,
  ) {
    super(message);
    this.name = 'BootstrapRejection';
  }
}

const rejectionText: Record<BootstrapErrorCode, string> = {
  PASSWORD_RULES: '密码不符合规则',
  PROFILE_NOT_FOUND: '资料不存在',
  CREDENTIAL_EXISTS: '凭据已存在且未带 --replace',
  MULTIPLE_CREDENTIALS: '存在多个凭据账户，需要先修复',
  UNKNOWN: '未知错误',
};

/** 操作者来源：命令行没有管理员会话，取运行它的主机与系统用户（不是自称的字符串）。 */
export function bootstrapActorLabel(): string {
  return `cli:auth:bootstrap@${hostname()}/${userInfo().username}`;
}

/**
 * 在 owner 连接上创建或替换一个资料的登录凭据（命令行 auth:bootstrap，不经 API）。
 * 审计（阶段 8 决定 41）写 operation_logs，操作者是 actor_label 而不是管理员：
 * 成功时凭据、会话撤销与审计在同一个事务里提交；拒绝或失败时事务回滚，随后另起短事务写一条
 * result = rejected | failed 与固定枚举 errorCode，尽力而为，写不进去只调用 warn，bootstrap 本身的结果不变。
 * 审计内容里没有密码、哈希、会话 token，也没有异常消息。
 */
export async function bootstrapCredential(input: {
  pool: Pool;
  auth: BillingAuth;
  kind: 'admin' | 'portal';
  profileId: string;
  password: string;
  replace: boolean;
  /** 审计的操作者来源，默认取主机与系统用户。 */
  actorLabel?: string;
  /** 审计没有写入时的提示，默认写标准错误。 */
  warn?: (message: string) => void;
}) {
  const client = await input.pool.connect();
  const mode = input.replace ? 'replace' : 'create';
  const actorLabel = input.actorLabel ?? bootstrapActorLabel();
  const warn =
    input.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  let inTransaction = false;
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
      throw new BootstrapRejection(
        'PASSWORD_RULES',
        'Password does not meet the shared password rules',
      );
    const context = await input.auth.$context;
    assertAuthOptions(context.options);
    const hash = await context.password.hash(input.password);
    await client.query('BEGIN');
    inTransaction = true;
    const table = input.kind === 'admin' ? 'admins' : 'portal_accounts';
    const target = await client.query<{
      id: string;
      email: string;
      tenant_id: string | null;
    }>(
      `SELECT u.id,u.email,${input.kind === 'portal' ? 'p.tenant_id' : 'NULL::uuid AS tenant_id'} FROM public.${table} p JOIN auth."user" u ON u.id=p.auth_user_id WHERE p.id=$1 FOR NO KEY UPDATE OF u`,
      [input.profileId],
    );
    const user = target.rows[0];
    if (!user)
      throw new BootstrapRejection('PROFILE_NOT_FOUND', 'Profile not found');
    const credentials = await client.query<{ id: string }>(
      "SELECT id FROM auth.account WHERE user_id=$1 AND provider_id='credential' FOR UPDATE",
      [user.id],
    );
    if (credentials.rows.length > 1)
      throw new BootstrapRejection(
        'MULTIPLE_CREDENTIALS',
        'Multiple credential accounts require repair',
      );
    const existing = credentials.rows[0];
    if (existing && !input.replace)
      throw new BootstrapRejection(
        'CREDENTIAL_EXISTS',
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
    let revokedSessions = 0;
    if (input.replace) {
      const revoked = await client.query(
        'DELETE FROM auth.session WHERE user_id=$1',
        [user.id],
      );
      revokedSessions = revoked.rowCount ?? 0;
    }
    await client.query('DELETE FROM auth.login_failures WHERE email_key=$1', [
      normalizeEmail(user.email),
    ]);
    await writeBootstrapAudit(client, input, {
      mode,
      actorLabel,
      tenantId: user.tenant_id,
      result: 'succeeded',
      errorCode: null,
      revokedSessions,
      summary: input.replace
        ? `替换${input.kind === 'admin' ? '管理员' : '门户账号'}凭据，撤销 ${revokedSessions} 个会话`
        : `创建${input.kind === 'admin' ? '管理员' : '门户账号'}凭据`,
    });
    await client.query('COMMIT');
    inTransaction = false;
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    // 角色不对时连接不能写 operation_logs，也不是对资料的操作，不记审计。
    if (!(
      error instanceof Error &&
      error.message === 'Credential bootstrap requires owner DATABASE_URL'
    )) {
      const rejected = error instanceof BootstrapRejection;
      const errorCode: BootstrapErrorCode = rejected ? error.code : 'UNKNOWN';
      try {
        await client.query('BEGIN');
        const tenantId =
          input.kind === 'portal'
            ? ((
                await client.query<{ tenant_id: string }>(
                  'SELECT tenant_id FROM public.portal_accounts WHERE id=$1',
                  [input.profileId],
                )
              ).rows[0]?.tenant_id ?? null)
            : null;
        await writeBootstrapAudit(client, input, {
          mode,
          actorLabel,
          tenantId,
          result: rejected ? 'rejected' : 'failed',
          errorCode,
          revokedSessions: 0,
          summary: `初始化凭据${rejected ? '被拒绝' : '失败'}：${rejectionText[errorCode]}`,
        });
        await client.query('COMMIT');
      } catch {
        await client.query('ROLLBACK').catch(() => undefined);
        warn('审计未写入');
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function writeBootstrapAudit(
  client: PoolClient,
  input: { kind: 'admin' | 'portal'; profileId: string },
  event: {
    mode: 'create' | 'replace';
    actorLabel: string;
    tenantId: string | null;
    result: 'succeeded' | 'rejected' | 'failed';
    errorCode: BootstrapErrorCode | null;
    revokedSessions: number;
    summary: string;
  },
) {
  const occurredAt = (
    await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  ).rows[0]!.now.toISOString();
  const payload = auditPayloadSchema.parse({
    id: randomUUID(),
    actor: { label: event.actorLabel },
    occurredAt,
    tenantId: event.tenantId,
    target: {
      kind: input.kind === 'admin' ? 'admin' : 'portal_account',
      id: input.profileId,
    },
    action: 'credential_bootstrap',
    content: {
      summary: event.summary,
      changes: [],
      mode: event.mode,
      result: event.result,
      errorCode: event.errorCode,
      revokedSessions: event.revokedSessions,
    },
  } satisfies BootstrapAudit);
  await client.query(
    `INSERT INTO public.operation_logs(id,admin_id,actor_label,tenant_id,action,target,details,created_at)
     VALUES($1,NULL,$2,$3,$4,$5,$6::jsonb,$7)`,
    [
      payload.id,
      event.actorLabel,
      payload.tenantId,
      payload.action,
      payload.target.id,
      JSON.stringify({
        actor: payload.actor,
        target: payload.target,
        content: payload.content,
      }),
      payload.occurredAt,
    ],
  );
}
