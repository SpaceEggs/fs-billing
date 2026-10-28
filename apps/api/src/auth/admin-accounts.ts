import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import {
  schema,
  withAdmin,
  lockTenants,
  writeAudit,
  databaseNow,
  AdminServiceError,
  type Db,
  type Tx,
} from '@fs-billing/db';
import {
  adminAccountSchema,
  adminPortalAccountSchema,
  type AdminAccountsQuery,
  type AdminAccountCreateRequest,
  type AdminPortalAccountCreateRequest,
} from '@fs-billing/shared';
import type { BillingAuth } from './better-auth.js';
import { normalizeEmail } from './gateway.js';
import type { AdminPrincipal } from '../types.js';

const insertedSchema = z.object({ inserted: z.boolean() });
const databaseTimestampSchema = z.coerce
  .date()
  .transform((value) => value.toISOString())
  .pipe(adminAccountSchema.shape.createdAt);
const adminListRowSchema = adminAccountSchema.extend({
  lastLoginAt: databaseTimestampSchema.nullable(),
  createdAt: databaseTimestampSchema,
});
const adminListRowsSchema = z.array(adminListRowSchema);
const portalListRowsSchema = z.array(
  adminPortalAccountSchema.extend({
    lastLoginAt: databaseTimestampSchema.nullable(),
    createdAt: databaseTimestampSchema,
  }),
);

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

export function createAdminAccountService(deps: {
  businessDb: Db;
  auth: BillingAuth;
  /** 审计失败的告警写不进去时记日志；不传则不记。 */
  logger?: Pick<FastifyBaseLogger, 'error'>;
}) {
  const { businessDb: db, auth } = deps;
  async function actor(tx: Tx, principal: AdminPrincipal) {
    const [row] = await tx
      .select()
      .from(schema.admins)
      .where(eq(schema.admins.id, principal.profileId));
    if (!row || row.status !== 'active')
      throw new AdminServiceError('FORBIDDEN', '管理员已停用');
    return { id: row.id, name: row.name };
  }
  async function hashPassword(password: string) {
    return (await auth.$context).password.hash(password);
  }
  async function insertCredential(tx: Tx, userId: string, hash: string) {
    const result = await tx.execute(
      sql`select auth.insert_credential(${randomUUID()}, ${userId}, ${hash}, clock_timestamp()) as inserted`,
    );
    if (!insertedSchema.parse(result.rows[0]).inserted)
      throw new Error('credential already exists');
  }
  async function setCredential(tx: Tx, userId: string, hash: string) {
    await tx.execute(
      sql`select auth.set_credential(${userId}, ${hash}, clock_timestamp())`,
    );
  }
  async function revokeSessions(tx: Tx, userId: string) {
    await tx.execute(sql`select auth.revoke_user_sessions(${userId})`);
  }
  async function clearLoginFailures(tx: Tx, emailKey: string) {
    await tx.execute(sql`select auth.clear_login_failures(${emailKey})`);
  }
  async function account(tx: Tx, kind: 'admin' | 'portal', id: string) {
    if (kind === 'portal') {
      const [target] = await tx
        .select({ tenantId: schema.portalAccounts.tenantId })
        .from(schema.portalAccounts)
        .where(eq(schema.portalAccounts.id, id));
      if (!target) throw new AdminServiceError('NOT_FOUND', '账号不存在');
      await lockTenants(tx, [target.tenantId]);
    }
    const table = kind === 'admin' ? schema.admins : schema.portalAccounts;
    const [row] = await tx.select().from(table).where(eq(table.id, id));
    if (!row) throw new AdminServiceError('NOT_FOUND', '账号不存在');
    return row;
  }
  /** 描述只有动作与对象 id，不含密码、邮箱或异常原文。写不进去只记日志，不影响响应。 */
  async function alertAuditFailed(
    kind: 'admin' | 'portal',
    id: string,
    tenantId: string | null,
  ) {
    try {
      await withAdmin(db, (tx) =>
        tx.insert(schema.systemAlerts).values({
          tenantId,
          kind: 'audit_failed',
          description: `重置密码的审计写入失败，凭据与会话未变更（${kind === 'admin' ? '管理员' : '门户账号'} ${id}）`,
        }),
      );
    } catch (error) {
      deps.logger?.error(
        { err: error, event: 'audit.alert_failed' },
        'Audit failure alert could not be written',
      );
    }
  }
  async function create(
    principal: AdminPrincipal,
    request:
      | { kind: 'admin'; body: AdminAccountCreateRequest }
      | {
          kind: 'portal';
          tenantId: string;
          body: AdminPortalAccountCreateRequest;
        },
  ) {
    const userId = randomUUID();
    const profileId = randomUUID();
    const auditId = randomUUID();
    const password =
      request.kind === 'portal'
        ? (request.body.initialPassword ??
          randomBytes(24).toString('base64url'))
        : randomBytes(24).toString('base64url');
    const normalizedEmail = normalizeEmail(request.body.email);
    const hash = await hashPassword(password);
    const row = await withAdmin(db, async (tx) => {
      if (request.kind === 'portal') {
        await lockTenants(tx, [request.tenantId]);
        const [tenant] = await tx
          .select({ id: schema.tenants.id })
          .from(schema.tenants)
          .where(eq(schema.tenants.id, request.tenantId));
        if (!tenant) throw new AdminServiceError('NOT_FOUND', '租户不存在');
        const [existing] = await tx
          .select({ id: schema.portalAccounts.id })
          .from(schema.portalAccounts)
          .where(eq(schema.portalAccounts.tenantId, request.tenantId));
        if (existing)
          throw new AdminServiceError(
            'PORTAL_ACCOUNT_EXISTS',
            '租户已有门户账号',
          );
      }
      const who = await actor(tx, principal);
      try {
        await tx.execute(
          sql`select auth.insert_user(${userId}, ${
            request.kind === 'admin' ? request.body.name : normalizedEmail
          }, ${normalizedEmail})`,
        );
      } catch (error) {
        if (isUserEmailConflict(error))
          throw new AdminServiceError('EMAIL_EXISTS', '邮箱已存在');
        throw error;
      }
      const [created] =
        request.kind === 'admin'
          ? await tx
              .insert(schema.admins)
              .values({
                id: profileId,
                authUserId: userId,
                name: request.body.name,
              })
              .returning()
          : await tx
              .insert(schema.portalAccounts)
              .values({
                id: profileId,
                authUserId: userId,
                tenantId: request.tenantId,
              })
              .returning();
      if (!created) throw new Error('Account profile creation failed');
      await insertCredential(tx, userId, hash);
      await writeAudit(tx, {
        id: auditId,
        actor: who,
        occurredAt: (await databaseNow(tx)).toISOString(),
        tenantId: request.kind === 'portal' ? request.tenantId : null,
        target: {
          kind: request.kind === 'admin' ? 'admin' : 'portal_account',
          id: profileId,
        },
        action:
          request.kind === 'admin' ? 'admin_create' : 'portal_account_create',
        content: { summary: '创建账号', changes: [], email: normalizedEmail },
      });
      return created;
    });
    const common = {
      id: row.id,
      status: row.status,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      email: normalizedEmail,
    };
    if (request.kind === 'admin')
      return {
        auditId,
        account: adminAccountSchema.parse({
          ...common,
          name: request.body.name,
        }),
        temporaryPassword: password,
      };
    const account = adminPortalAccountSchema.parse(common);
    return request.body.initialPassword === undefined
      ? {
          auditId,
          account,
          passwordSource: 'generated' as const,
          temporaryPassword: password,
        }
      : { auditId, account, passwordSource: 'supplied' as const };
  }
  return {
    createAdmin: (principal: AdminPrincipal, body: AdminAccountCreateRequest) =>
      create(principal, { kind: 'admin', body }),
    createPortal: (
      principal: AdminPrincipal,
      tenantId: string,
      body: AdminPortalAccountCreateRequest,
    ) => create(principal, { kind: 'portal', tenantId, body }),
    async listAdmins(query: AdminAccountsQuery) {
      const result = await withAdmin(db, (tx) =>
        tx.execute(sql`
          WITH filtered_admins AS MATERIALIZED (
            SELECT * FROM public.admins
            WHERE ${query.status ? sql`status = ${query.status}` : sql`true`}
          )
          SELECT a.id, a.name, a.status, emails.email,
            a.last_login_at AS "lastLoginAt", a.created_at AS "createdAt"
          FROM filtered_admins a
          LEFT JOIN auth.lookup_user_emails(
            ARRAY(SELECT auth_user_id FROM filtered_admins)
          ) emails ON emails.user_id = a.auth_user_id
          ORDER BY a.created_at, a.id
        `),
      );
      const items = adminListRowsSchema.parse(result.rows);
      const search = query.search?.toLowerCase();
      const matching = search
        ? items.filter(
            (row) =>
              row.name.toLowerCase().includes(search) ||
              row.email.toLowerCase().includes(search),
          )
        : items;
      return {
        items: matching.slice(
          (query.page - 1) * query.pageSize,
          query.page * query.pageSize,
        ),
        pagination: {
          page: query.page,
          pageSize: query.pageSize,
          total: matching.length,
        },
      };
    },
    async listPortal(tenantId: string) {
      const rows = await withAdmin(db, async (tx) => {
        const [tenant] = await tx
          .select({ id: schema.tenants.id })
          .from(schema.tenants)
          .where(eq(schema.tenants.id, tenantId));
        if (!tenant) throw new AdminServiceError('NOT_FOUND', '租户不存在');
        const result = await tx.execute(sql`
          WITH filtered_portal_accounts AS MATERIALIZED (
            SELECT * FROM public.portal_accounts
            WHERE tenant_id = ${tenantId}::uuid
          )
          SELECT p.id, p.status, emails.email,
            p.last_login_at AS "lastLoginAt", p.created_at AS "createdAt"
          FROM filtered_portal_accounts p
          LEFT JOIN auth.lookup_user_emails(
            ARRAY(SELECT auth_user_id FROM filtered_portal_accounts)
          ) emails ON emails.user_id = p.auth_user_id
        `);
        return portalListRowsSchema.parse(result.rows);
      });
      return { items: rows };
    },
    async setStatus(
      principal: AdminPrincipal,
      command: {
        kind: 'admin' | 'portal';
        id: string;
        status: 'active' | 'disabled';
      },
    ) {
      const { kind, status } = command;
      const id = command.id.toLowerCase();
      if (
        kind === 'admin' &&
        status === 'disabled' &&
        id === principal.profileId.toLowerCase()
      )
        throw new AdminServiceError('SELF_DISABLE', '不能停用当前管理员');
      return withAdmin(
        db,
        async (tx) => {
          const who = await actor(tx, principal);
          const row = await account(tx, kind, id);
          if (row.status === status) return { auditId: null };
          const writtenAuditId = randomUUID();
          if (kind === 'admin') {
            // All mutations of admins.status must run SERIALIZABLE via the outermost wrapper to prevent write skew.
            const [updated] = await tx
              .update(schema.admins)
              .set({ status })
              .where(
                and(
                  eq(schema.admins.id, id),
                  eq(schema.admins.status, row.status),
                  sql`exists (select 1 from public.admins where id = ${who.id}::uuid and status = 'active')`,
                  status === 'disabled'
                    ? sql`(select count(*) from public.admins where status = 'active') > 1`
                    : undefined,
                ),
              )
              .returning({ id: schema.admins.id });
            if (!updated) {
              await actor(tx, principal);
              // Enable cannot reach LAST_ADMIN because actor rejection or a 40001 aborts it first.
              throw new AdminServiceError(
                'LAST_ADMIN',
                '不能停用最后一名管理员',
              );
            }
          } else {
            await tx
              .update(schema.portalAccounts)
              .set({ status })
              .where(eq(schema.portalAccounts.id, id));
          }
          const tenantId = 'tenantId' in row ? row.tenantId : null;
          await writeAudit(tx, {
            id: writtenAuditId,
            actor: who,
            occurredAt: (await databaseNow(tx)).toISOString(),
            tenantId,
            target: { kind: kind === 'admin' ? 'admin' : 'portal_account', id },
            action:
              kind === 'admin'
                ? status === 'active'
                  ? 'admin_enable'
                  : 'admin_disable'
                : status === 'active'
                  ? 'portal_account_enable'
                  : 'portal_account_disable',
            content: {
              summary: status === 'active' ? '启用账号' : '停用账号',
              changes: [{ field: 'status', before: row.status, after: status }],
            },
          });
          await revokeSessions(tx, row.authUserId);
          return { auditId: writtenAuditId };
        },
        kind === 'admin' ? { isolationLevel: 'serializable' } : undefined,
      );
    },
    async resetPassword(
      principal: AdminPrincipal,
      kind: 'admin' | 'portal',
      id: string,
    ) {
      id = id.toLowerCase();
      if (kind === 'admin' && id === principal.profileId.toLowerCase())
        throw new AdminServiceError('FORBIDDEN', '不能重置当前管理员密码');
      const temporaryPassword = randomBytes(24).toString('base64url');
      const hash = await hashPassword(temporaryPassword);
      const auditId = randomUUID();
      // 凭据、会话撤销与审计在同一个事务里：审计写不进去则整个重置回滚，不存在「已重置而无审计」（决定 40）。
      // 审计失败时事务已回滚，另起事务尽力写一条 audit_failed 告警，让运维不必只靠 5xx 日志发现。
      let failedAudit: { tenantId: string | null } | undefined;
      try {
        await withAdmin(db, async (tx) => {
          failedAudit = undefined;
          const who = await actor(tx, principal);
          const row = await account(tx, kind, id);
          const emails = await tx.execute(
            sql`select email from auth.lookup_user_emails(ARRAY[${row.authUserId}::text])`,
          );
          const address = z
            .object({ email: z.string().min(1) })
            .parse(emails.rows[0]).email;
          await setCredential(tx, row.authUserId, hash);
          await clearLoginFailures(tx, normalizeEmail(address));
          await revokeSessions(tx, row.authUserId);
          const tenantId = 'tenantId' in row ? row.tenantId : null;
          failedAudit = { tenantId };
          await writeAudit(tx, {
            id: auditId,
            actor: who,
            occurredAt: (await databaseNow(tx)).toISOString(),
            tenantId,
            target: { kind: kind === 'admin' ? 'admin' : 'portal_account', id },
            action: 'reset_password',
            content: { summary: '重置密码', changes: [] },
          });
          failedAudit = undefined;
        });
      } catch (error) {
        if (failedAudit) await alertAuditFailed(kind, id, failedAudit.tenantId);
        throw error;
      }
      return { temporaryPassword };
    },
  };
}
export type AdminAccountService = ReturnType<typeof createAdminAccountService>;
