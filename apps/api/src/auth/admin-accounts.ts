import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { and, asc, eq, sql } from 'drizzle-orm';
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
  authPool: Pool;
  auth: BillingAuth;
}) {
  const { businessDb: db, authPool: pool, auth } = deps;
  async function email(userId: string) {
    const result = await pool.query<{ email: string }>(
      'SELECT email FROM auth."user" WHERE id=$1',
      [userId],
    );
    const value = result.rows[0]?.email;
    if (!value) throw new Error('Linked auth user missing');
    return value;
  }
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
      const rows = await withAdmin(db, (tx) =>
        tx
          .select()
          .from(schema.admins)
          .where(
            and(
              query.status ? eq(schema.admins.status, query.status) : undefined,
            ),
          )
          .orderBy(asc(schema.admins.createdAt), asc(schema.admins.id)),
      );
      const items = await Promise.all(
        rows.map(async (row) =>
          adminAccountSchema.parse({
            id: row.id,
            name: row.name,
            status: row.status,
            email: await email(row.authUserId),
            lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
          }),
        ),
      );
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
        return tx
          .select()
          .from(schema.portalAccounts)
          .where(eq(schema.portalAccounts.tenantId, tenantId));
      });
      return {
        items: await Promise.all(
          rows.map(async (row) =>
            adminPortalAccountSchema.parse({
              id: row.id,
              status: row.status,
              email: await email(row.authUserId),
              lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
              createdAt: row.createdAt.toISOString(),
            }),
          ),
        ),
      };
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
      await withAdmin(db, async (tx) => {
        const who = await actor(tx, principal);
        const row = await account(tx, kind, id);
        const address = await email(row.authUserId);
        await setCredential(tx, row.authUserId, hash);
        await clearLoginFailures(tx, normalizeEmail(address));
        await revokeSessions(tx, row.authUserId);
        await writeAudit(tx, {
          id: auditId,
          actor: who,
          occurredAt: (await databaseNow(tx)).toISOString(),
          tenantId: 'tenantId' in row ? row.tenantId : null,
          target: { kind: kind === 'admin' ? 'admin' : 'portal_account', id },
          action: 'reset_password',
          content: { summary: '重置密码', changes: [] },
        });
      });
      return { temporaryPassword };
    },
  };
}
export type AdminAccountService = ReturnType<typeof createAdminAccountService>;
