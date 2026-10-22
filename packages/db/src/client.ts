import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { z } from 'zod';
import * as schema from './schema.js';
import { retryTransaction } from './retry.js';
import { normalizePgOperation } from './unavailable.js';

export const APP_ROLE = 'fs_billing_app';
export const AUTH_ROLE = 'fs_billing_auth';

const postgresUrl = z.url().refine((value) => /^postgres(?:ql)?:/.test(value), {
  message: '必须使用 PostgreSQL 协议',
});

/** DATABASE_URL：owner，用于迁移与种子；APP_DATABASE_URL：应用角色，RLS 生效。 */
export const databaseEnvironmentSchema = z.object({
  DATABASE_URL: postgresUrl,
  AUTH_DATABASE_URL: postgresUrl
    .refine(
      (value) => decodeURIComponent(new URL(value).username) === AUTH_ROLE,
      { message: `认证连接必须使用 ${AUTH_ROLE} 角色` },
    )
    .optional(),
  APP_DATABASE_URL: postgresUrl.refine(
    (value) => decodeURIComponent(new URL(value).username) === APP_ROLE,
    { message: `应用连接必须使用 ${APP_ROLE} 角色` },
  ),
});
export type DatabaseEnvironment = z.infer<typeof databaseEnvironmentSchema>;

export type Db = NodePgDatabase<typeof schema>;
// 连接池数据库带 $client；事务没有该字段，不能作为独立维护操作的入口。
export type PoolDb = Db & { readonly $client: pg.Pool };
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface Connection {
  readonly db: PoolDb;
  readonly pool: pg.Pool;
}

interface PoolErrorLogger {
  error(
    fields: {
      event: 'database.idle_client_error';
      pool: string;
      code: string;
    },
    message: string,
  ): void;
}

const defaultPoolErrorLogger: PoolErrorLogger = {
  error: (fields, message) => {
    process.stderr.write(
      `${JSON.stringify({ level: 'error', ...fields, message })}\n`,
    );
  },
};

const networkErrorCodes = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

// numeric 原样以字符串返回（pg 默认如此）；timestamptz 解析为 Date。
export function connect(
  url: string,
  options: Pick<
    pg.PoolConfig,
    | 'max'
    | 'connectionTimeoutMillis'
    | 'application_name'
    | 'idleTimeoutMillis'
    | 'statement_timeout'
    | 'idle_in_transaction_session_timeout'
  > & {
    logger?: PoolErrorLogger;
    poolName?: string;
  } = {},
): Connection {
  const {
    logger = defaultPoolErrorLogger,
    poolName = 'database',
    ...poolOptions
  } = options;
  const pool = new pg.Pool({ connectionString: url, ...poolOptions });
  pool.on('error', (error) => {
    // Error messages, stacks and client objects can contain connection credentials.
    const code =
      'code' in error &&
      typeof error.code === 'string' &&
      (/^[0-9A-Z]{5}$/.test(error.code) || networkErrorCodes.has(error.code))
        ? error.code
        : error.message === 'Connection terminated unexpectedly'
          ? 'CONNECTION_TERMINATED'
          : 'unknown';
    logger.error(
      { event: 'database.idle_client_error', pool: poolName, code },
      'Database idle connection failed',
    );
  });
  pool.connect = normalizePgOperation(pool.connect.bind(pool));
  pool.query = normalizePgOperation(pool.query.bind(pool));
  pool.on('connect', (client) => {
    // pg also rejects the active query; its accompanying error event must not crash a checked-out transaction.
    client.on('error', () => undefined);
    const ownsQuery = Object.hasOwn(client, 'query');
    /* eslint-disable @typescript-eslint/unbound-method -- The proxy forwards the original receiver through Reflect.apply. */
    client.query = normalizePgOperation(
      new Proxy(client.query, {
        apply(target, receiver: unknown, args: unknown[]) {
          // Resolve at call time so instrumentation added after checkout remains in the query path.
          const result: unknown = Reflect.apply(
            ownsQuery ? target : pg.Client.prototype.query,
            receiver,
            args,
          );
          return result;
        },
      }),
    );
    /* eslint-enable @typescript-eslint/unbound-method */
  });
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
  config?: OperatorTransactionConfig,
): Promise<T> {
  return withOperator(db, 'admin', fn, config);
}

/**
 * 以系统身份执行（Worker：入库、扣费、建分区、生成账单）：可见并可写全部租户。重试规则同 withAdmin。
 * 月账单用 `repeatable read` 取一致快照；SET TRANSACTION ISOLATION LEVEL 必须是事务的第一条语句，
 * 所以隔离级别只能在这里请求，不能在 fn 里设置。
 */
export function withSystem<T>(
  db: Db | Tx,
  fn: (tx: Tx) => Promise<T>,
  config?: OperatorTransactionConfig,
): Promise<T> {
  return withOperator(db, 'system', fn, config);
}

/** 只能在最外层事务请求；`repeatable read` 用于一致快照读取，不使用 SSI 的 `serializable` 以免误伤并发扣费。 */
export interface OperatorTransactionConfig {
  isolationLevel: 'serializable' | 'repeatable read';
}

// 死锁（40P01）与序列化失败（40001）回滚整个事务，重跑 fn 是安全的。
// 嵌套时出错的只是保存点，外层事务里先前的语句和锁还在，重跑保存点不等于重跑事务，所以只在最外层重试。
const MAX_ATTEMPTS = 3;
// 快照类隔离级别遇到并发提交的冲突行会收到 40001，多给几次重试机会。
const SNAPSHOT_MAX_ATTEMPTS = 8;

async function withOperator<T>(
  db: Db | Tx,
  scope: 'admin' | 'system',
  fn: (tx: Tx) => Promise<T>,
  config?: OperatorTransactionConfig,
): Promise<T> {
  // All mutations of admins.status must request SERIALIZABLE through the outermost wrapper.
  // Drizzle ignores isolation config on savepoints, so nested requests must fail.
  if (db instanceof PgTransaction && config?.isolationLevel)
    throw new Error(
      'Transaction isolation must be requested at the outermost layer',
    );
  const attempts =
    db instanceof PgTransaction
      ? 1
      : config?.isolationLevel
        ? SNAPSHOT_MAX_ATTEMPTS
        : MAX_ATTEMPTS;
  return retryTransaction({
    attempts,
    operation: () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.scope', ${scope}, true)`);
        return fn(tx);
      }, config),
  });
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
