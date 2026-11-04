import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  auditPayloadSchema,
  newPasswordSchema,
  type AuditPayload,
} from '@fs-billing/shared';
import type { BillingAuth } from './better-auth.js';
import { assertAuthOptions } from './better-auth.js';
import { normalizeEmail } from './gateway.js';

type AdminCreateAudit = Extract<
  AuditPayload,
  { action: 'credential_bootstrap' }
>;

/** 已知的拒绝：消息里没有输入，可以原样给操作者看。 */
export class AdminCreateRejection extends Error {
  constructor(
    readonly code: 'INVALID_INPUT' | 'PASSWORD_RULES' | 'EMAIL_EXISTS',
    message: string,
  ) {
    super(message);
    this.name = 'AdminCreateRejection';
  }
}

/** 操作者来源：命令行没有管理员会话，取运行它的主机与系统用户（不是自称的字符串）。 */
export function adminCreateActorLabel(): string {
  return `cli:admin:create@${hostname()}/${userInfo().username}`;
}

const adminCreateInputSchema = z.object({
  email: z.email(),
  name: z.string().trim().min(1).max(200),
});

function isUserEmailConflict(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (
      'code' in current &&
      current.code === '23505' &&
      'constraint' in current &&
      current.constraint === 'user_email_key'
    )
      return true;
  }
  return false;
}

/**
 * 在 owner 连接上创建第一个管理员（命令行 admin:create，不经 API）：`auth.user`、`admins` 资料与
 * 临时密码凭据。凭据带 `temporary_password_issued_at`，首登后 API 要求改密（与后台创建管理员一致）。
 * 操作日志（阶段 8 决定 41）写 operation_logs，操作者是 actor_label 而不是管理员；创建与审计在同一个
 * 事务里提交，审计写不进去则整体回滚。审计内容里没有密码或哈希。
 */
export async function createAdmin(input: {
  pool: Pool;
  auth: BillingAuth;
  email: string;
  name: string;
  password: string;
  /** 审计的操作者来源，默认取主机与系统用户。 */
  actorLabel?: string;
}): Promise<{ userId: string; profileId: string; auditId: string }> {
  const client = await input.pool.connect();
  const actorLabel = input.actorLabel ?? adminCreateActorLabel();
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
      throw new Error('Admin creation requires owner DATABASE_URL');
    const parsed = adminCreateInputSchema.safeParse({
      email: input.email,
      name: input.name,
    });
    if (!parsed.success)
      throw new AdminCreateRejection(
        'INVALID_INPUT',
        'A valid --email and --name are required',
      );
    const email = normalizeEmail(parsed.data.email);
    // Never include Zod input values in a password validation error.
    if (!newPasswordSchema.safeParse(input.password).success)
      throw new AdminCreateRejection(
        'PASSWORD_RULES',
        'Password does not meet the shared password rules',
      );
    const context = await input.auth.$context;
    assertAuthOptions(context.options);
    const hash = await context.password.hash(input.password);
    const userId = randomUUID();
    const profileId = randomUUID();
    const auditId = randomUUID();
    await client.query('BEGIN');
    inTransaction = true;
    try {
      await client.query('SELECT auth.insert_user($1,$2,$3)', [
        userId,
        parsed.data.name,
        email,
      ]);
    } catch (error) {
      if (isUserEmailConflict(error))
        throw new AdminCreateRejection(
          'EMAIL_EXISTS',
          'An account with this email already exists',
        );
      throw error;
    }
    await client.query(
      'INSERT INTO public.admins(id,auth_user_id,name) VALUES($1,$2,$3)',
      [profileId, userId, parsed.data.name],
    );
    const credential = await client.query<{ inserted: boolean }>(
      'SELECT auth.insert_credential($1,$2,$3,clock_timestamp()) AS inserted',
      [randomUUID(), userId, hash],
    );
    if (!credential.rows[0]?.inserted)
      throw new Error('Admin credential creation failed');
    await writeAdminCreateAudit(client, {
      auditId,
      actorLabel,
      profileId,
      summary: `创建管理员「${parsed.data.name}」`,
    });
    await client.query('COMMIT');
    inTransaction = false;
    return { userId, profileId, auditId };
  } catch (error) {
    if (inTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function writeAdminCreateAudit(
  client: PoolClient,
  event: {
    auditId: string;
    actorLabel: string;
    profileId: string;
    summary: string;
  },
) {
  const occurredAt = (
    await client.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  ).rows[0]!.now.toISOString();
  const payload = auditPayloadSchema.parse({
    id: event.auditId,
    actor: { label: event.actorLabel },
    occurredAt,
    tenantId: null,
    target: { kind: 'admin', id: event.profileId },
    action: 'credential_bootstrap',
    content: {
      summary: event.summary,
      changes: [],
      mode: 'create',
      result: 'succeeded',
      errorCode: null,
      revokedSessions: 0,
    },
  } satisfies AdminCreateAudit);
  await client.query(
    `INSERT INTO public.operation_logs(id,admin_id,actor_label,tenant_id,action,target,details,created_at)
     VALUES($1,NULL,$2,NULL,$3,$4,$5::jsonb,$6)`,
    [
      payload.id,
      event.actorLabel,
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
