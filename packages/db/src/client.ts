import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { z } from 'zod';
import * as schema from './schema.js';

export const APP_ROLE = 'fs_billing_app';

const postgresUrl = z.url().refine((value) => /^postgres(?:ql)?:/.test(value), {
  message: '必须使用 PostgreSQL 协议',
});

/** DATABASE_URL：owner，用于迁移与种子；APP_DATABASE_URL：应用角色，RLS 生效。 */
export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: postgresUrl,
  APP_DATABASE_URL: postgresUrl.refine(
    (value) => decodeURIComponent(new URL(value).username) === APP_ROLE,
    { message: `应用连接必须使用 ${APP_ROLE} 角色` },
  ),
});
export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Connection {
  readonly db: Db;
  readonly pool: pg.Pool;
}

// numeric 原样以字符串返回（pg 默认如此）；timestamptz 解析为 Date。
export function connect(url: string): Connection {
  const pool = new pg.Pool({ connectionString: url });
  return { pool, db: drizzle(pool, { schema }) };
}

/** 以租户身份执行（客户门户）：RLS 只放行读取该租户的行，任何写入都被拒绝。 */
export function withTenant<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('app.scope', 'tenant', true), set_config('app.tenant_id', ${tenantId}, true)`,
    );
    return fn(tx);
  });
}

/**
 * 以管理员身份执行（管理后台）：可见并可写全部租户。
 * 最外层事务遇到 40P01 / 40001 会回滚并重跑 fn，所以 fn 只能做数据库操作且可重跑：
 * 不发邮件、不调外部接口、不改事务外的内存状态。在已有事务里调用时只开保存点，不重试，错误原样抛出。
 */
export function withAdmin<T>(
  db: Db | Tx,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withOperator(db, 'admin', fn);
}

/** 以系统身份执行（Worker：入库、扣费、建分区）：可见并可写全部租户。重试规则同 withAdmin。 */
export function withSystem<T>(
  db: Db | Tx,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return withOperator(db, 'system', fn);
}

// 死锁（40P01）与序列化失败（40001）回滚整个事务，重跑 fn 是安全的。
// 嵌套时出错的只是保存点，外层事务里先前的语句和锁还在，重跑保存点不等于重跑事务，所以只在最外层重试。
const RETRYABLE = new Set(['40P01', '40001']);
const MAX_ATTEMPTS = 3;

async function withOperator<T>(
  db: Db | Tx,
  scope: 'admin' | 'system',
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const attempts = db instanceof PgTransaction ? 1 : MAX_ATTEMPTS;
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.scope', ${scope}, true)`);
        return fn(tx);
      });
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(sqlState(error) ?? '')) {
        throw error;
      }
    }
  }
}

/** drizzle 把驱动错误包在 cause 里。 */
function sqlState(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    if ('code' in current && typeof current.code === 'string') {
      return current.code;
    }
  }
  return undefined;
}

/**
 * 拿这些租户的事务级互斥锁。改费率、写流水的事务必须在任何写入和行锁之前调用，否则报 55000；
 * 数据库触发器在写入时检查锁是本事务通过 lock_tenants 拿到的。同一事务的全部租户放进一次调用。
 * 租户身份只能锁自己的租户，否则报 42501。
 */
export async function lockTenants(
  tx: Tx,
  tenantIds: readonly string[],
): Promise<void> {
  await tx.execute(
    sql`select lock_tenants(array[${sql.join(
      tenantIds.map((id) => sql`${id}`),
      sql`, `,
    )}]::uuid[])`,
  );
}
