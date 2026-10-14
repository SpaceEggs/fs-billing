import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, inject } from 'vitest';
import type { Currency } from '@fs-billing/rating';
import {
  connect,
  withAdmin,
  type Connection,
  type Db,
  type Tx,
} from '../src/client.js';
import { tenants } from '../src/schema.js';

/** 每个测试文件一个应用角色连接和一个 owner 连接，文件结束时关闭。 */
export function connections(): { app: Connection; owner: Connection } {
  const app = connect(inject('appUrl'));
  const owner = connect(inject('ownerUrl'));
  afterAll(async () => {
    await app.pool.end();
    await owner.pool.end();
  });
  return { app, owner };
}

/** drizzle 把驱动错误包在 cause 里；返回底层 PostgreSQL 错误。 */
export async function pgError(
  promise: Promise<unknown>,
): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await promise;
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error) {
      if ('code' in current && typeof current.code === 'string') {
        return current as unknown as { code: string; message: string };
      }
      current = current.cause;
    }
    throw error;
  }
  throw new Error('期望数据库报错，但语句成功了');
}

/** 以管理员身份新建一个测试租户，避免修改种子租户的数据。 */
export async function createTenant<C extends Currency>(
  { db }: Connection,
  currency: C,
): Promise<{ id: string; code: string; currency: C }> {
  const code = `T${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const [row] = await withAdmin(db, (tx) =>
    tx
      .insert(tenants)
      .values({
        code,
        name: `测试 ${code}`,
        currency,
        overdraftLimit: '100.00',
      })
      .returning({ id: tenants.id }),
  );
  return { id: row!.id, code, currency };
}

/** 不重试的管理员事务。并发测试要看到 40P01，withAdmin 会把它重试掉。 */
export function adminTransaction<T>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.scope', 'admin', true)`);
    return fn(tx);
  });
}

export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function backendPid(tx: Tx): Promise<number> {
  const { rows } = await tx.execute<{ pid: number }>(
    sql`select pg_backend_pid() as pid`,
  );
  return rows[0]!.pid;
}

/** 等到 `pid` 在 `tenantId` 的租户锁上排队：pg_locks 里有它未授予的那把 advisory 锁。 */
export async function waitForTenantLock(
  { pool }: Connection,
  pid: number,
  tenantId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { rows } = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS (
         SELECT FROM pg_locks
         WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
           AND ((classid::bigint << 32) | objid::bigint) = tenant_lock_key($2)
       ) AS waiting`,
      [pid, tenantId],
    );
    if (rows[0]!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`连接 ${pid} 没有在租户 ${tenantId} 的锁上等待`);
}

/** 种子管理员王敏的编号。 */
export async function adminId({ pool }: Connection): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT a.id FROM public.admins a JOIN auth."user" u ON u.id = a.auth_user_id WHERE u.email = 'wangmin@example.com'`,
  );
  return rows[0]!.id;
}

export async function tenantId({ db }: Connection, code: string) {
  const { rows } = await withAdmin(db, (tx) =>
    tx.execute<{ id: string }>(
      sql`select id from tenants where code = ${code}`,
    ),
  );
  return rows[0]!.id;
}
